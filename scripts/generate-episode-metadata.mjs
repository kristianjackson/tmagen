#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

const DEFAULT_ENV_FILE = "./apps/web/.dev.vars";
const DEFAULT_MODEL = "gpt-5-mini";
const DEFAULT_CONCURRENCY = 4;
const METADATA_SCHEMA_VERSION = 2;
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const MAX_TRANSCRIPT_CHARS = 45000;
const TRANSCRIPT_TAIL_CHARS = 18000;

class OpenAiServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpenAiServiceError";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const envFile = path.resolve(args["env-file"] ?? DEFAULT_ENV_FILE);
  const limit = args.limit ? Number(args.limit) : undefined;
  const episodeNumber = args.episode ? Number(args.episode) : undefined;
  const concurrency = args.concurrency ? Number(args.concurrency) : DEFAULT_CONCURRENCY;
  const dryRun = Boolean(args["dry-run"]);
  const force = Boolean(args.force);
  const reset = Boolean(args.reset);

  if (typeof limit === "number" && Number.isNaN(limit)) {
    throw new Error("--limit must be a number");
  }

  if (typeof episodeNumber === "number" && Number.isNaN(episodeNumber)) {
    throw new Error("--episode must be a number");
  }

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }

  const env = await loadEnvFile(envFile);
  const model = args.model ?? env.OPENAI_CHAT_MODEL ?? DEFAULT_MODEL;
  const supabase = createClient(
    requireEnv(env, "SUPABASE_URL"),
    requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          "X-Client-Info": "tmagen/metadata-generator",
        },
      },
    },
  );

  const [fearTaxonomy, episodes] = await Promise.all([
    loadFearTaxonomy(supabase),
    loadEpisodes({
      supabase,
      episodeNumber,
    }),
  ]);

  const selectedEpisodes = episodes
    .filter((episode) =>
      reset ? hasAnyGeneratedMetadata(episode) : force || !hasCurrentMetadata(episode),
    )
    .slice(0, typeof limit === "number" ? limit : undefined);

  logSelection({
    totalEpisodes: episodes.length,
    selectedEpisodes,
    dryRun,
    force,
    model,
    reset,
    concurrency,
  });

  if (selectedEpisodes.length === 0) {
    console.log("No episodes need metadata generation.");
    return;
  }

  if (dryRun) {
    return;
  }

  if (reset) {
    let resetCount = 0;

    for (const episode of selectedEpisodes) {
      await resetEpisodeMetadata({
        supabase,
        episodeId: episode.id,
      });
      resetCount += 1;
      console.log(
        `Reset metadata for MAG ${String(episode.episodeNumber).padStart(3, "0")} ${episode.title}`,
      );
    }

    console.log(`Metadata reset finished: ${resetCount} episodes returned to ready.`);
    return;
  }

  const openAiApiKey = requireEnv(env, "OPENAI_API_KEY");
  const { processedCount, failedCount, aborted, usageTotals } =
    await processMetadataBatch({
      supabase,
      selectedEpisodes,
      openAiApiKey,
      model,
      fearTaxonomy,
      concurrency,
    });

  console.log(
    `Metadata generation finished: ${processedCount} updated, ${failedCount} failed${aborted ? ", batch aborted" : ""}.`,
  );
  console.log(`OpenAI usage: ${formatUsage(usageTotals)}`);

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);

    if (key === "dry-run" || key === "force" || key === "help" || key === "reset") {
      parsed[key] = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage:
  node scripts/generate-episode-metadata.mjs [options]

Options:
  --env-file <path>   Path to the TMAGen env file. Default: ./apps/web/.dev.vars
  --episode <number>  Only process one episode number
  --limit <number>    Process at most this many episodes
  --model <name>      Override OPENAI_CHAT_MODEL
  --concurrency <n>   Number of episodes to process in parallel. Default: 4
  --force             Regenerate metadata even if the episode already has it
  --reset             Clear generated metadata and return selected episodes to ready
  --dry-run           Show which episodes would be processed without calling OpenAI
  --help              Show this message
`);
}

async function processMetadataBatch({
  supabase,
  selectedEpisodes,
  openAiApiKey,
  model,
  fearTaxonomy,
  concurrency,
}) {
  let processedCount = 0;
  let failedCount = 0;
  let aborted = false;
  let abortLogged = false;
  let nextIndex = 0;
  const usageTotals = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  const workerCount = Math.min(concurrency, selectedEpisodes.length);

  async function processNextEpisode() {
    while (nextIndex < selectedEpisodes.length && !aborted) {
      const episode = selectedEpisodes[nextIndex];
      nextIndex += 1;

      try {
        const generated = await generateEpisodeMetadata({
          openAiApiKey,
          model,
          episode,
          fearTaxonomy,
        });

        await updateEpisodeMetadata({
          supabase,
          episodeId: episode.id,
          generated,
        });

        processedCount += 1;
        usageTotals.promptTokens += generated.usage.promptTokens;
        usageTotals.completionTokens += generated.usage.completionTokens;
        usageTotals.totalTokens += generated.usage.totalTokens;
        console.log(
          `Generated metadata for MAG ${String(episode.episodeNumber).padStart(3, "0")} ${episode.title} -> ${generated.primaryFearSlug} (${formatUsage(generated.usage)})`,
        );
      } catch (error) {
        const shouldAbort = shouldAbortBatch(error);

        failedCount += 1;
        if (shouldAbort) {
          aborted = true;
        }

        if (!shouldAbort && !hasCurrentMetadata(episode)) {
          await markEpisodeMetadataFailure({
            supabase,
            episodeId: episode.id,
          }).catch(() => null);
        }

        console.error(
          `Failed MAG ${String(episode.episodeNumber).padStart(3, "0")} ${episode.title}: ${formatError(error)}`,
        );

        if (shouldAbort && !abortLogged) {
          abortLogged = true;
          console.error("Aborting metadata generation because the OpenAI failure is systemic.");
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => processNextEpisode()));

  return {
    processedCount,
    failedCount,
    aborted,
    usageTotals,
  };
}

async function loadFearTaxonomy(supabase) {
  const { data, error } = await supabase
    .from("fears")
    .select("slug, name, description, sort_order")
    .order("sort_order", { ascending: true });

  if (error) {
    throw new Error(`Failed to load fear taxonomy: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error("Fear taxonomy is empty. Apply the initial schema and seed data first.");
  }

  return data.map((fear) => ({
    slug: fear.slug,
    name: fear.name,
    description: fear.description,
  }));
}

async function loadEpisodes({ supabase, episodeNumber }) {
  let query = supabase
    .from("episodes")
    .select(
      "id, episode_number, title, slug, transcript_text, content_warnings, summary, hook, primary_fear_slug, secondary_fear_slugs, generated_metadata, import_status",
    )
    .order("episode_number", { ascending: true });

  if (typeof episodeNumber === "number") {
    query = query.eq("episode_number", episodeNumber);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to load episodes: ${error.message}`);
  }

  if (typeof episodeNumber === "number" && (!data || data.length === 0)) {
    throw new Error(`No episode found for --episode ${episodeNumber}`);
  }

  return (data ?? []).map((episode) => ({
    id: episode.id,
    episodeNumber: episode.episode_number,
    title: episode.title,
    slug: episode.slug,
    transcriptText: episode.transcript_text,
    contentWarnings: episode.content_warnings ?? [],
    summary: episode.summary,
    hook: episode.hook,
    primaryFearSlug: episode.primary_fear_slug,
    secondaryFearSlugs: episode.secondary_fear_slugs ?? [],
    generatedMetadata: asRecord(episode.generated_metadata),
    importStatus: episode.import_status,
  }));
}

function hasCurrentMetadata(episode) {
  return (
    typeof episode.summary === "string" &&
    episode.summary.trim().length > 0 &&
    typeof episode.hook === "string" &&
    episode.hook.trim().length > 0 &&
    typeof episode.primaryFearSlug === "string" &&
    episode.primaryFearSlug.trim().length > 0 &&
    episode.generatedMetadata.schema_version === METADATA_SCHEMA_VERSION
  );
}

function hasAnyGeneratedMetadata(episode) {
  return (
    episode.importStatus === "metadata_ready" ||
    episode.importStatus === "metadata_failed" ||
    (typeof episode.summary === "string" && episode.summary.trim().length > 0) ||
    (typeof episode.hook === "string" && episode.hook.trim().length > 0) ||
    (typeof episode.primaryFearSlug === "string" && episode.primaryFearSlug.trim().length > 0) ||
    episode.secondaryFearSlugs.length > 0 ||
    Object.keys(episode.generatedMetadata).length > 0
  );
}

function logSelection({ totalEpisodes, selectedEpisodes, dryRun, force, model, reset, concurrency }) {
  const mode = dryRun ? "dry-run" : reset ? "reset" : "write";
  const forceLabel = force ? ", force enabled" : "";
  const actionLabel = reset ? "reset" : "metadata generation";
  const concurrencyLabel = reset ? "" : `, concurrency ${concurrency}`;

  console.log(
    `[${mode}] Loaded ${totalEpisodes} episodes. Selected ${selectedEpisodes.length} for ${actionLabel}${reset ? "" : ` with ${model}`}${concurrencyLabel}${forceLabel}.`,
  );

  for (const episode of selectedEpisodes.slice(0, 5)) {
    console.log(
      `  MAG ${String(episode.episodeNumber).padStart(3, "0")} ${episode.title} (${episode.importStatus})`,
    );
  }

  if (selectedEpisodes.length > 5) {
    console.log(`  ... ${selectedEpisodes.length - 5} more episodes`);
  }
}

async function generateEpisodeMetadata({ openAiApiKey, model, episode, fearTaxonomy }) {
  const promptTranscript = prepareTranscriptForPrompt(episode.transcriptText);
  let response;

  try {
    const responseFormat = buildResponseFormat(fearTaxonomy);

    response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        response_format: responseFormat,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(fearTaxonomy),
          },
          {
            role: "user",
            content: buildUserPrompt({
              episode,
              promptTranscript,
            }),
          },
        ],
      }),
    });
  } catch (error) {
    throw new OpenAiServiceError(
      `OpenAI request failed before receiving a response: ${formatError(error)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new OpenAiServiceError(
      `OpenAI request failed (${response.status}): ${body.slice(0, 500)}`,
    );
  }

  const payload = await response.json();
  const refusal = payload?.choices?.[0]?.message?.refusal;

  if (typeof refusal === "string" && refusal.trim().length > 0) {
    throw new Error(`OpenAI refused the request: ${refusal}`);
  }

  const content = readAssistantContent(payload);

  if (!content) {
    throw new Error("OpenAI response did not include assistant text content.");
  }

  const parsed = parseJsonObject(content);

  return normalizeGeneratedMetadata({
    raw: parsed,
    model,
    episode,
    transcriptWasTruncated: promptTranscript.wasTruncated,
    fearTaxonomy,
    usage: normalizeUsage(payload?.usage),
  });
}

function buildSystemPrompt(fearTaxonomy) {
  const fearLines = fearTaxonomy
    .map((fear) => `- ${fear.slug}: ${fear.name}. ${fear.description}`)
    .join("\n");

  return `Role: internal TMAGen metadata editor for retrieval and editorial review.

Writing controls:
- Be concise, concrete, and spoiler-aware.
- Write in plain prose, not marketing copy.
- Do not use markdown, bullet points, or transcript quotes in any string field.
- Base every field strictly on the transcript content provided.
- If something is unclear, use null or [] rather than inventing details.

Allowed fear taxonomy:
${fearLines}

Completion criteria:
- Return one JSON object only.
- Use the exact schema keys requested by the response format.
- hook must be a single sentence under 180 characters.
- primaryFearSlug and secondaryFearSlugs must use only allowed fear slugs.
- secondaryFearSlugs must not repeat the primary fear or each other.
- retrievalKeywords must contain 6 to 14 short phrases.
- If you cannot support a field from the transcript, leave it null or [] instead of guessing.

Before finalizing, verify the output satisfies every rule above.`;
}

function buildUserPrompt({ episode, promptTranscript }) {
  const contentWarnings =
    episode.contentWarnings.length > 0 ? episode.contentWarnings.join("; ") : "None extracted";

  return `<episode_request>
  <episode_number>${episode.episodeNumber}</episode_number>
  <title>${escapeXml(episode.title)}</title>
  <slug>${escapeXml(episode.slug)}</slug>
  <extracted_content_warnings>${escapeXml(contentWarnings)}</extracted_content_warnings>
  <prompt_transcript_truncated>${promptTranscript.wasTruncated ? "yes" : "no"}</prompt_transcript_truncated>
</episode_request>

<task>
Produce internal TMAGen episode metadata for retrieval, tagging, and story-seed support.
</task>

<transcript>
${escapeXml(promptTranscript.text)}
</transcript>`;
}

function buildResponseFormat(fearTaxonomy) {
  return {
    type: "json_schema",
    json_schema: {
      name: "tmagen_episode_metadata",
      strict: true,
      schema: buildMetadataJsonSchema(fearTaxonomy),
    },
  };
}

function buildMetadataJsonSchema(fearTaxonomy) {
  const fearSlugs = fearTaxonomy.map((fear) => fear.slug);

  return {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "hook",
      "primaryFearSlug",
      "secondaryFearSlugs",
      "statementGiver",
      "notableCharacters",
      "notableLocations",
      "themes",
      "retrievalKeywords",
      "storySeed",
      "fearRationale",
    ],
    properties: {
      summary: {
        type: "string",
        minLength: 40,
        maxLength: 900,
      },
      hook: {
        type: "string",
        minLength: 20,
        maxLength: 180,
      },
      primaryFearSlug: {
        type: "string",
        enum: fearSlugs,
      },
      secondaryFearSlugs: {
        type: "array",
        items: {
          type: "string",
          enum: fearSlugs,
        },
        minItems: 0,
        maxItems: 3,
      },
      statementGiver: {
        type: ["string", "null"],
        maxLength: 120,
      },
      notableCharacters: {
        type: "array",
        items: {
          type: "string",
          minLength: 1,
          maxLength: 80,
        },
        minItems: 0,
        maxItems: 8,
      },
      notableLocations: {
        type: "array",
        items: {
          type: "string",
          minLength: 1,
          maxLength: 120,
        },
        minItems: 0,
        maxItems: 6,
      },
      themes: {
        type: "array",
        items: {
          type: "string",
          minLength: 1,
          maxLength: 80,
        },
        minItems: 0,
        maxItems: 6,
      },
      retrievalKeywords: {
        type: "array",
        items: {
          type: "string",
          minLength: 1,
          maxLength: 80,
        },
        minItems: 6,
        maxItems: 14,
      },
      storySeed: {
        type: "string",
        minLength: 40,
        maxLength: 420,
      },
      fearRationale: {
        type: "string",
        minLength: 20,
        maxLength: 420,
      },
    },
  };
}

function prepareTranscriptForPrompt(text) {
  const stripped = stripCredits(text);

  if (stripped.length <= MAX_TRANSCRIPT_CHARS) {
    return {
      text: stripped,
      wasTruncated: false,
    };
  }

  const headChars = MAX_TRANSCRIPT_CHARS - TRANSCRIPT_TAIL_CHARS;

  return {
    text: `${stripped.slice(0, headChars).trim()}\n\n[... transcript truncated for prompt length ...]\n\n${stripped.slice(-TRANSCRIPT_TAIL_CHARS).trim()}`,
    wasTruncated: true,
  };
}

function stripCredits(text) {
  const withoutLicense = text.replace(
    /\n+\[The Magnus Archives Theme[^\n]*Outro[^\n]*\][\s\S]*$/i,
    "",
  );

  return withoutLicense.trim();
}

function readAssistantContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .join("")
      .trim();
  }

  return "";
}

function parseJsonObject(content) {
  const trimmed = content.trim();
  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFences);
  } catch {
    const firstBrace = withoutFences.indexOf("{");
    const lastBrace = withoutFences.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("Model output was not valid JSON.");
    }

    return JSON.parse(withoutFences.slice(firstBrace, lastBrace + 1));
  }
}

function normalizeGeneratedMetadata({
  raw,
  model,
  episode,
  transcriptWasTruncated,
  fearTaxonomy,
  usage,
}) {
  const primaryFearSlug = normalizeFearSlug(
    raw.primaryFearSlug ?? raw.primary_fear_slug,
    fearTaxonomy,
  );

  if (!primaryFearSlug) {
    throw new Error("Model response did not include a valid primary fear slug.");
  }

  const secondaryFearSlugs = normalizeStringArray(
    raw.secondaryFearSlugs ?? raw.secondary_fear_slugs,
    {
      maxItems: 3,
      maxLength: 40,
    },
  )
    .map((value) => normalizeFearSlug(value, fearTaxonomy))
    .filter(Boolean)
    .filter((value) => value !== primaryFearSlug);

  return {
    summary: normalizeRequiredText(raw.summary, 900, "summary"),
    hook: normalizeRequiredText(raw.hook, 180, "hook"),
    primaryFearSlug,
    secondaryFearSlugs: dedupeStrings(secondaryFearSlugs),
    generatedMetadata: {
      schema_version: METADATA_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      model,
      statement_giver: normalizeOptionalText(
        raw.statementGiver ?? raw.statement_giver,
        120,
      ),
      notable_characters: normalizeStringArray(raw.notableCharacters, {
        maxItems: 8,
        maxLength: 80,
      }),
      notable_locations: normalizeStringArray(raw.notableLocations, {
        maxItems: 6,
        maxLength: 120,
      }),
      themes: normalizeStringArray(raw.themes, {
        maxItems: 6,
        maxLength: 80,
      }),
      retrieval_keywords: normalizeRequiredStringArray(raw.retrievalKeywords, {
        minItems: 6,
        maxItems: 14,
        maxLength: 80,
        label: "retrievalKeywords",
      }),
      story_seed: normalizeRequiredText(raw.storySeed, 420, "storySeed"),
      fear_rationale: normalizeRequiredText(raw.fearRationale, 420, "fearRationale"),
      transcript_truncated_for_prompt: transcriptWasTruncated,
      source_episode_number: episode.episodeNumber,
      source_slug: episode.slug,
      openai_usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    },
    usage,
  };
}

async function updateEpisodeMetadata({ supabase, episodeId, generated }) {
  const { error } = await supabase
    .from("episodes")
    .update({
      summary: generated.summary,
      hook: generated.hook,
      primary_fear_slug: generated.primaryFearSlug,
      secondary_fear_slugs: generated.secondaryFearSlugs,
      generated_metadata: generated.generatedMetadata,
      import_status: "metadata_ready",
    })
    .eq("id", episodeId);

  if (error) {
    throw new Error(`Failed to update episode metadata: ${error.message}`);
  }
}

async function resetEpisodeMetadata({ supabase, episodeId }) {
  const { error } = await supabase
    .from("episodes")
    .update({
      summary: null,
      hook: null,
      primary_fear_slug: null,
      secondary_fear_slugs: [],
      generated_metadata: {},
      import_status: "ready",
    })
    .eq("id", episodeId);

  if (error) {
    throw new Error(`Failed to reset episode metadata: ${error.message}`);
  }
}

async function markEpisodeMetadataFailure({ supabase, episodeId }) {
  const { error } = await supabase
    .from("episodes")
    .update({
      import_status: "metadata_failed",
    })
    .eq("id", episodeId);

  if (error) {
    throw new Error(`Failed to mark metadata failure: ${error.message}`);
  }
}

function normalizeFearSlug(value, fearTaxonomy) {
  const normalized = normalizeOptionalText(value, 40);

  if (!normalized) {
    return null;
  }

  const slug = slugify(normalized);
  const slugSet = new Set(fearTaxonomy.map((fear) => fear.slug));

  if (slugSet.has(slug)) {
    return slug;
  }

  if (slugSet.has(`the-${slug}`)) {
    return `the-${slug}`;
  }

  const byName = new Map(
    fearTaxonomy.flatMap((fear) => [
      [slugify(fear.name), fear.slug],
      [slugify(fear.name.replace(/^The\s+/i, "")), fear.slug],
    ]),
  );

  return byName.get(slug) ?? null;
}

function normalizeRequiredText(value, maxLength, label) {
  const normalized = normalizeOptionalText(value, maxLength);

  if (!normalized) {
    throw new Error(`Model response did not include a usable ${label}.`);
  }

  return normalized;
}

function normalizeOptionalText(value, maxLength) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength).trim();
}

function normalizeStringArray(value, { maxItems, maxLength }) {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeStrings(
    value
      .map((item) => normalizeOptionalText(item, maxLength))
      .filter(Boolean),
  ).slice(0, maxItems);
}

function normalizeRequiredStringArray(value, { minItems, maxItems, maxLength, label }) {
  const normalized = normalizeStringArray(value, { maxItems, maxLength });

  if (normalized.length < minItems) {
    throw new Error(`Model response did not include enough values for ${label}.`);
  }

  return normalized;
}

function dedupeStrings(values) {
  const seen = new Set();
  const deduped = [];

  for (const value of values) {
    const key = value.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(value);
  }

  return deduped;
}

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

async function loadEnvFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  const env = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function requireEnv(env, key) {
  const value = env[key];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required key in env file: ${key}`);
  }

  return value;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function normalizeUsage(usage) {
  const promptTokens = asNonNegativeInteger(usage?.prompt_tokens);
  const completionTokens = asNonNegativeInteger(usage?.completion_tokens);
  const totalTokens =
    asNonNegativeInteger(usage?.total_tokens) ?? promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function asNonNegativeInteger(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
}

function formatUsage(usage) {
  return `prompt ${usage.promptTokens.toLocaleString()}, completion ${usage.completionTokens.toLocaleString()}, total ${usage.totalTokens.toLocaleString()}`;
}

function shouldAbortBatch(error) {
  return error instanceof OpenAiServiceError;
}

main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
