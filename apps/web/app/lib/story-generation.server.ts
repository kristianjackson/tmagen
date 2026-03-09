import type { SupabaseClient } from "@supabase/supabase-js";

import type { AppEnv } from "./env.server";
import {
  runChunkRetrievalProbe,
  type RetrievalProbe,
} from "./retrieval.server";
import { buildStoryRetrievalQuery } from "./story-generation";

const DEFAULT_MODEL = "gpt-5-mini";
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const INITIAL_SYSTEM_PROMPT_VERSION = "workspace-draft-v1";
const REVISION_SYSTEM_PROMPT_VERSION = "workspace-revision-v1";
const MAX_RETRIEVAL_RESULTS = 8;
const MAX_COMPLETION_TOKENS = 5000;
const MAX_DRAFT_REQUEST_ATTEMPTS = 2;
const MIN_DRAFT_CHARACTERS = 1500;

type StoryProjectInput = {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  seedPrompt: string | null;
  canonMode: "strict" | "adjacent" | "au";
  castPolicy: "none" | "cameo" | "full";
  selectedFearSlugs: string[];
  visibility: "private" | "unlisted" | "public";
};

type FearOption = {
  slug: string;
  name: string;
  description: string;
};

type ExistingStoryVersion = {
  id: string;
  versionNumber: number;
  modelName: string | null;
  contentMarkdown: string;
  promptSnapshot: Record<string, unknown>;
  retrievalSnapshot: unknown[];
  generationMetadata: Record<string, unknown>;
};

type GeneratedDraft = {
  attemptCount: number;
  contentMarkdown: string;
  usage: {
    completionTokens: number;
    promptTokens: number;
    totalTokens: number;
  };
  systemPrompt: string;
  userPrompt: string;
};

type OpenAiChatCompletionPayload = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string } | string>;
      refusal?: string | null;
    };
  }>;
  usage?: {
    completion_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

type StoredRetrievalResult = RetrievalProbe["results"][number];

export async function generateStoryVersionFromProject({
  adminClient,
  env,
  fears,
  project,
  supabase,
}: {
  adminClient: SupabaseClient;
  env: AppEnv;
  fears: FearOption[];
  project: StoryProjectInput;
  supabase: SupabaseClient;
}) {
  const retrievalQuery = buildStoryRetrievalQuery(project);

  if (!retrievalQuery) {
    throw new Error("Add a summary or seed prompt before generating a draft.");
  }

  const retrieval = await runChunkRetrievalProbe({
    adminClient,
    env,
    fearSlugs: project.selectedFearSlugs,
    matchCount: MAX_RETRIEVAL_RESULTS,
    query: retrievalQuery,
  });

  if (retrieval.results.length === 0) {
    throw new Error("Retrieval returned no source material for this brief.");
  }

  const latestVersion = await loadLatestVersion(supabase, project.id);
  const nextVersionNumber = (latestVersion?.versionNumber ?? 0) + 1;
  const model = normalizeOptionalString(env.OPENAI_CHAT_MODEL) ?? DEFAULT_MODEL;
  const selectedFears = fears.filter((fear) => project.selectedFearSlugs.includes(fear.slug));
  const systemPrompt = buildSystemPrompt({
    castPolicy: project.castPolicy,
    canonMode: project.canonMode,
    mode: "generation",
    selectedFears,
  });
  const generated = await requestDraft({
    title: project.title,
    buildUserPrompt: ({ attempt }) => buildUserPrompt({ attempt, project, retrieval }),
    model,
    openAiApiKey: requireEnvBinding(env, "OPENAI_API_KEY"),
    systemPrompt,
  });

  const promptSnapshot = {
    schema_version: 1,
    mode: "brief-generation",
    system_prompt_version: INITIAL_SYSTEM_PROMPT_VERSION,
    project: {
      canon_mode: project.canonMode,
      cast_policy: project.castPolicy,
      selected_fear_slugs: project.selectedFearSlugs,
      seed_prompt: project.seedPrompt,
      slug: project.slug,
      summary: project.summary,
      title: project.title,
      visibility: project.visibility,
    },
    retrieval_query: retrieval.query,
    system_prompt: generated.systemPrompt,
    user_prompt: generated.userPrompt,
  };
  const generationMetadata = {
    schema_version: 1,
    generation_mode: "brief-generation",
    generated_at: new Date().toISOString(),
    generation_attempts: generated.attemptCount,
    model,
    openai_usage: {
      prompt_tokens: generated.usage.promptTokens,
      completion_tokens: generated.usage.completionTokens,
      total_tokens: generated.usage.totalTokens,
    },
    retrieval_query: retrieval.query,
    retrieval_warning_count: retrieval.warnings.length,
    retrieval_warnings: retrieval.warnings,
    canon_mode: project.canonMode,
    cast_policy: project.castPolicy,
  };

  const { data: insertedVersion, error: insertError } = await supabase
    .from("story_versions")
    .insert({
      content_markdown: generated.contentMarkdown,
      generation_metadata: generationMetadata,
      model_name: model,
      parent_version_id: latestVersion?.id ?? null,
      prompt_snapshot: promptSnapshot,
      retrieval_snapshot: buildRetrievalSnapshot(retrieval),
      revision_notes:
        latestVersion === null
          ? "Initial generated draft from workspace brief."
          : "Fresh generated draft from workspace brief.",
      story_project_id: project.id,
      system_prompt_version: INITIAL_SYSTEM_PROMPT_VERSION,
      version_number: nextVersionNumber,
      visibility: project.visibility,
    })
    .select("id")
    .single();

  if (insertError || !insertedVersion) {
    throw new Error(`Failed to create story version: ${insertError?.message ?? "Unknown error"}`);
  }

  try {
    const episodeLinks = buildStoryEpisodeLinks({
      project,
      retrieval,
      storyVersionId: insertedVersion.id,
    });

    if (episodeLinks.length > 0) {
      const { error: linksError } = await supabase
        .from("story_episode_links")
        .insert(episodeLinks);

      if (linksError) {
        throw new Error(`Failed to write provenance links: ${linksError.message}`);
      }
    }
  } catch (error) {
    await supabase.from("story_versions").delete().eq("id", insertedVersion.id);
    throw error;
  }

  return {
    retrieval,
    storyVersionId: insertedVersion.id,
    versionNumber: nextVersionNumber,
  };
}

export async function reviseStoryVersionFromProject({
  env,
  fears,
  project,
  revisionInstructions,
  storyVersion,
  supabase,
  viewerUserId,
}: {
  env: AppEnv;
  fears: FearOption[];
  project: StoryProjectInput;
  revisionInstructions: string;
  storyVersion: ExistingStoryVersion;
  supabase: SupabaseClient;
  viewerUserId: string;
}) {
  const retrieval = restoreRetrievalFromSnapshot({ project, storyVersion });
  const latestVersion = await loadLatestVersion(supabase, project.id);
  const nextVersionNumber = (latestVersion?.versionNumber ?? 0) + 1;
  const model = normalizeOptionalString(env.OPENAI_CHAT_MODEL) ?? DEFAULT_MODEL;
  const selectedFears = fears.filter((fear) => project.selectedFearSlugs.includes(fear.slug));
  const systemPrompt = buildSystemPrompt({
    castPolicy: project.castPolicy,
    canonMode: project.canonMode,
    mode: "revision",
    selectedFears,
  });
  const generated = await requestDraft({
    title: project.title,
    buildUserPrompt: ({ attempt }) =>
      buildRevisionUserPrompt({
        attempt,
        project,
        retrieval,
        revisionInstructions,
        storyVersion,
      }),
    model,
    openAiApiKey: requireEnvBinding(env, "OPENAI_API_KEY"),
    systemPrompt,
  });

  const promptSnapshot = {
    schema_version: 1,
    mode: "revision",
    parent_version_id: storyVersion.id,
    parent_version_number: storyVersion.versionNumber,
    revision_instructions: revisionInstructions,
    system_prompt_version: REVISION_SYSTEM_PROMPT_VERSION,
    project: {
      canon_mode: project.canonMode,
      cast_policy: project.castPolicy,
      selected_fear_slugs: project.selectedFearSlugs,
      seed_prompt: project.seedPrompt,
      slug: project.slug,
      summary: project.summary,
      title: project.title,
      visibility: project.visibility,
    },
    retrieval_query: retrieval.query,
    system_prompt: generated.systemPrompt,
    user_prompt: generated.userPrompt,
  };
  const generationMetadata = {
    schema_version: 1,
    generation_mode: "revision",
    generated_at: new Date().toISOString(),
    generation_attempts: generated.attemptCount,
    model,
    openai_usage: {
      prompt_tokens: generated.usage.promptTokens,
      completion_tokens: generated.usage.completionTokens,
      total_tokens: generated.usage.totalTokens,
    },
    retrieval_query: retrieval.query,
    retrieval_warning_count: 0,
    retrieval_warnings: [],
    canon_mode: project.canonMode,
    cast_policy: project.castPolicy,
    parent_version_id: storyVersion.id,
    parent_version_number: storyVersion.versionNumber,
    parent_model_name: storyVersion.modelName,
  };

  const { data: insertedVersion, error: insertError } = await supabase
    .from("story_versions")
    .insert({
      content_markdown: generated.contentMarkdown,
      generation_metadata: generationMetadata,
      model_name: model,
      parent_version_id: storyVersion.id,
      prompt_snapshot: promptSnapshot,
      retrieval_snapshot: buildRetrievalSnapshot(retrieval),
      revision_notes: revisionInstructions,
      story_project_id: project.id,
      system_prompt_version: REVISION_SYSTEM_PROMPT_VERSION,
      version_number: nextVersionNumber,
      visibility: project.visibility,
    })
    .select("id")
    .single();

  if (insertError || !insertedVersion) {
    throw new Error(
      `Failed to create revised story version: ${insertError?.message ?? "Unknown error"}`,
    );
  }

  try {
    const episodeLinks = buildStoryEpisodeLinks({
      project,
      retrieval,
      storyVersionId: insertedVersion.id,
      usageReason: `Retrieved for revision of version ${storyVersion.versionNumber} in "${project.title}" using query "${truncateForReason(retrieval.query)}".`,
    });

    if (episodeLinks.length > 0) {
      const { error: linksError } = await supabase
        .from("story_episode_links")
        .insert(episodeLinks);

      if (linksError) {
        throw new Error(`Failed to write revision provenance links: ${linksError.message}`);
      }
    }

    const { error: feedbackError } = await supabase.from("story_feedback").insert({
      applied: true,
      author_id: viewerUserId,
      feedback_text: revisionInstructions,
      story_project_id: project.id,
      story_version_id: insertedVersion.id,
    });

    if (feedbackError) {
      throw new Error(`Failed to record applied revision notes: ${feedbackError.message}`);
    }
  } catch (error) {
    await supabase.from("story_versions").delete().eq("id", insertedVersion.id);
    throw error;
  }

  return {
    retrieval,
    storyVersionId: insertedVersion.id,
    versionNumber: nextVersionNumber,
  };
}

async function loadLatestVersion(supabase: SupabaseClient, storyProjectId: string) {
  const { data, error } = await supabase
    .from("story_versions")
    .select("id, version_number")
    .eq("story_project_id", storyProjectId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to inspect existing story versions: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return {
    id: data.id,
    versionNumber: data.version_number,
  };
}

async function requestDraft({
  title,
  buildUserPrompt,
  model,
  openAiApiKey,
  systemPrompt,
}: {
  title: string;
  buildUserPrompt: ({ attempt }: { attempt: number }) => string;
  model: string;
  openAiApiKey: string;
  systemPrompt: string;
}): Promise<GeneratedDraft> {
  const usageTotals = {
    completionTokens: 0,
    promptTokens: 0,
    totalTokens: 0,
  };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_DRAFT_REQUEST_ATTEMPTS; attempt += 1) {
    const userPrompt = buildUserPrompt({ attempt });
    let response: Response;

    try {
      response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openAiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
    } catch (error) {
      throw new Error(`OpenAI draft request failed: ${formatError(error)}`);
    }

    if (!response.ok) {
      throw new Error(
        `OpenAI draft request failed (${response.status}): ${(await response.text()).slice(0, 400)}`,
      );
    }

    const payload = (await response.json()) as OpenAiChatCompletionPayload;
    const refusal = payload?.choices?.[0]?.message?.refusal;

    usageTotals.completionTokens += asInteger(payload?.usage?.completion_tokens);
    usageTotals.promptTokens += asInteger(payload?.usage?.prompt_tokens);
    usageTotals.totalTokens += asInteger(payload?.usage?.total_tokens);

    if (typeof refusal === "string" && refusal.trim().length > 0) {
      throw new Error(`OpenAI refused the draft request: ${refusal}`);
    }

    try {
      const contentMarkdown = normalizeDraftContent(readAssistantContent(payload), title);

      return {
        attemptCount: attempt,
        contentMarkdown,
        systemPrompt,
        userPrompt,
        usage: usageTotals,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(formatError(error));

      if (!isRetryableDraftError(lastError) || attempt === MAX_DRAFT_REQUEST_ATTEMPTS) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("OpenAI draft request failed without returning a usable draft.");
}

function buildSystemPrompt({
  canonMode,
  castPolicy,
  mode,
  selectedFears,
}: {
  canonMode: StoryProjectInput["canonMode"];
  castPolicy: StoryProjectInput["castPolicy"];
  mode: "generation" | "revision";
  selectedFears: FearOption[];
}) {
  const fearLines =
    selectedFears.length > 0
      ? selectedFears.map((fear) => `- ${fear.name}: ${fear.description}`).join("\n")
      : "- No explicit fear filter. Infer from the retrieved archive material.";
  const workflowGuidance =
    mode === "revision"
      ? `Revision workflow:
- You are revising an existing full draft, not writing notes about it.
- Apply the revision instructions precisely.
- Return a complete replacement draft, not patch notes or commentary.
- Preserve the strongest working material when it does not conflict with the requested changes.`
      : "Write one complete draft that feels ready for human revision.";

  return `Role: TMAGen story drafter for archive-grounded horror fiction.

Writing controls:
- Output markdown only.
- Begin with a single H1 title, then write the story body in prose.
- Write a complete short story draft of roughly 900 to 1,600 words.
- Keep the voice atmospheric, controlled, and readable rather than purple.
- Do not mention being an AI, prompt instructions, source packets, or retrieval.
- Avoid direct quotation from the source archive beyond a few words.
- Favor original scenes over recap.

Canon mode guidance:
- strict: remain fully compatible with established canon facts, timeline, and character status.
- adjacent: stay plausibly canon-compatible, but you may tell a new story at the edges of canon.
- au: Alternate Universe mode. You may deliberately shift setting, roles, or timeline as long as the fear logic, tone, and internal consistency stay strong.

Cast policy guidance:
- none: avoid canon characters as active participants.
- cameo: canon characters may appear briefly or be referenced, but they should not dominate the draft.
- full: canon characters may be central if the brief and retrieval support it.

Selected fears:
${fearLines}

Active constraints:
- Canon mode: ${canonMode}
- Cast policy: ${castPolicy}

${workflowGuidance}`;
}

function buildUserPrompt({
  attempt,
  project,
  retrieval,
}: {
  attempt: number;
  project: StoryProjectInput;
  retrieval: RetrievalProbe;
}) {
  const fearList =
    project.selectedFearSlugs.length > 0 ? project.selectedFearSlugs.join(", ") : "None selected";
  const retrievalPacket = serializeRetrievalPacket(retrieval);

  return `<story_brief>
  <title>${escapeXml(project.title)}</title>
  <slug>${escapeXml(project.slug)}</slug>
  <summary>${escapeXml(project.summary ?? "")}</summary>
  <seed_prompt>${escapeXml(project.seedPrompt ?? "")}</seed_prompt>
  <canon_mode>${project.canonMode}</canon_mode>
  <cast_policy>${project.castPolicy}</cast_policy>
  <selected_fears>${escapeXml(fearList)}</selected_fears>
</story_brief>

<task>
Write the next story draft for this project. Use the retrieval packet as grounding material, but produce an original piece of fiction rather than summary or notes. Return a complete story draft with a clear beginning, escalation, and ending.
</task>

<retrieval_query>
${escapeXml(retrieval.query)}
</retrieval_query>

<retrieval_packet>
${retrievalPacket}
</retrieval_packet>${attempt > 1 ? "\n\n<retry_instruction>\nThe previous answer was too short. Retry from scratch and return a full story draft between 900 and 1,600 words.\n</retry_instruction>" : ""}`;
}

function buildRevisionUserPrompt({
  attempt,
  project,
  retrieval,
  revisionInstructions,
  storyVersion,
}: {
  attempt: number;
  project: StoryProjectInput;
  retrieval: RetrievalProbe;
  revisionInstructions: string;
  storyVersion: ExistingStoryVersion;
}) {
  const fearList =
    project.selectedFearSlugs.length > 0 ? project.selectedFearSlugs.join(", ") : "None selected";
  const retrievalPacket = serializeRetrievalPacket(retrieval);

  return `<story_brief>
  <title>${escapeXml(project.title)}</title>
  <slug>${escapeXml(project.slug)}</slug>
  <summary>${escapeXml(project.summary ?? "")}</summary>
  <seed_prompt>${escapeXml(project.seedPrompt ?? "")}</seed_prompt>
  <canon_mode>${project.canonMode}</canon_mode>
  <cast_policy>${project.castPolicy}</cast_policy>
  <selected_fears>${escapeXml(fearList)}</selected_fears>
</story_brief>

<task>
Revise the current draft using the revision instructions. Produce a full replacement draft in markdown, not notes, bullets, or commentary.
</task>

<revision_instructions>
${escapeXml(revisionInstructions)}
</revision_instructions>

<current_draft>
${escapeXml(storyVersion.contentMarkdown)}
</current_draft>

<retrieval_query>
${escapeXml(retrieval.query)}
</retrieval_query>

<retrieval_packet>
${retrievalPacket}
</retrieval_packet>${attempt > 1 ? "\n\n<retry_instruction>\nThe previous answer was too short. Retry from scratch and return a full replacement draft between 900 and 1,600 words.\n</retry_instruction>" : ""}`;
}

function serializeRetrievalPacket(retrieval: RetrievalProbe) {
  return retrieval.results
    .map(
      (result, index) => `<source index="${index + 1}">
  <episode_number>${result.episodeNumber}</episode_number>
  <episode_title>${escapeXml(result.episodeTitle)}</episode_title>
  <episode_slug>${escapeXml(result.episodeSlug)}</episode_slug>
  <chunk_index>${result.chunkIndex}</chunk_index>
  <fear_slugs>${escapeXml(result.fearSlugs.join(", "))}</fear_slugs>
  <excerpt>${escapeXml(result.excerpt)}</excerpt>
</source>`,
    )
    .join("\n\n");
}

function buildStoryEpisodeLinks({
  project,
  retrieval,
  storyVersionId,
  usageReason,
}: {
  project: StoryProjectInput;
  retrieval: RetrievalProbe;
  storyVersionId: string;
  usageReason?: string;
}) {
  const linksByEpisode = new Map<
    string,
    {
      chunkIds: string[];
      episodeId: string;
      relevanceScore: number;
    }
  >();

  for (const result of retrieval.results) {
    const current = linksByEpisode.get(result.episodeId) ?? {
      chunkIds: [],
      episodeId: result.episodeId,
      relevanceScore: 0,
    };

    if (!current.chunkIds.includes(result.chunkId)) {
      current.chunkIds.push(result.chunkId);
    }

    current.relevanceScore = Math.max(current.relevanceScore, result.fusedScore);
    linksByEpisode.set(result.episodeId, current);
  }

  const resolvedUsageReason =
    usageReason ??
    `Retrieved for story draft generation from brief "${project.title}" using query "${truncateForReason(retrieval.query)}".`;

  return Array.from(linksByEpisode.values()).map((link) => ({
    chunk_ids: link.chunkIds,
    episode_id: link.episodeId,
    relevance_score: Number(link.relevanceScore.toFixed(6)),
    story_version_id: storyVersionId,
    usage_reason: resolvedUsageReason,
  }));
}

function buildRetrievalSnapshot(retrieval: RetrievalProbe) {
  return retrieval.results.map((result) => ({
    chunk_id: result.chunkId,
    chunk_index: result.chunkIndex,
    episode_id: result.episodeId,
    episode_number: result.episodeNumber,
    episode_slug: result.episodeSlug,
    episode_title: result.episodeTitle,
    excerpt: result.excerpt,
    fear_slugs: result.fearSlugs,
    fused_score: result.fusedScore,
    lexical_score: result.lexicalScore,
    similarity: result.similarity,
    sources: result.sources,
  }));
}

function restoreRetrievalFromSnapshot({
  project,
  storyVersion,
}: {
  project: StoryProjectInput;
  storyVersion: ExistingStoryVersion;
}): RetrievalProbe {
  const results = storyVersion.retrievalSnapshot
    .map(parseStoredRetrievalResult)
    .filter((value): value is StoredRetrievalResult => value !== null);

  if (results.length === 0) {
    throw new Error("The selected draft has no saved source packet to revise from.");
  }

  const storedQuery =
    readOptionalString(storyVersion.promptSnapshot.retrieval_query) ??
    readOptionalString(storyVersion.generationMetadata.retrieval_query) ??
    buildStoryRetrievalQuery(project);

  if (!storedQuery) {
    throw new Error("The selected draft is missing its retrieval query.");
  }

  return {
    query: storedQuery,
    normalizedQuery: storedQuery.trim(),
    fearSlug: project.selectedFearSlugs.length === 1 ? project.selectedFearSlugs[0] : null,
    fearSlugs: project.selectedFearSlugs,
    episodeId: null,
    vectorHitCount: results.filter((result) => result.sources.includes("vector")).length,
    lexicalHitCount: results.filter((result) => result.sources.includes("lexical")).length,
    usage: null,
    warnings: [],
    results,
  };
}

function parseStoredRetrievalResult(value: unknown): StoredRetrievalResult | null {
  const record = asRecord(value);
  const chunkId = readOptionalString(record.chunk_id);
  const episodeId = readOptionalString(record.episode_id);
  const episodeSlug = readOptionalString(record.episode_slug);
  const episodeTitle = readOptionalString(record.episode_title);
  const excerpt = readOptionalString(record.excerpt);
  const episodeNumber = asInteger(record.episode_number);

  if (!chunkId || !episodeId || !episodeSlug || !episodeTitle || !excerpt || episodeNumber <= 0) {
    return null;
  }

  return {
    chunkId,
    chunkIndex: asInteger(record.chunk_index),
    episodeId,
    episodeNumber,
    episodeSlug,
    episodeTitle,
    excerpt,
    fearSlugs: readStringArray(record.fear_slugs),
    fusedScore: readOptionalNumber(record.fused_score) ?? 0,
    lexicalScore: readOptionalNumber(record.lexical_score),
    similarity: readOptionalNumber(record.similarity),
    sources: readSources(record.sources),
  };
}

function normalizeDraftContent(content: string, title: string) {
  const trimmed = content.trim();

  if (trimmed.length < MIN_DRAFT_CHARACTERS) {
    throw new Error("Model output was too short to count as a usable story draft.");
  }

  if (trimmed.startsWith("# ")) {
    return trimmed;
  }

  return `# ${title}\n\n${trimmed}`;
}

function readAssistantContent(payload: OpenAiChatCompletionPayload) {
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

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function truncateForReason(value: string, maxLength = 140) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeOptionalString(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireEnvBinding<T extends keyof AppEnv>(env: AppEnv, key: T) {
  const value = env[key];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required environment binding: ${String(key)}`);
  }

  return value;
}

function asInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  return 0;
}

function readOptionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readSources(value: unknown): Array<"vector" | "lexical"> {
  return readStringArray(value).filter(
    (source): source is "vector" | "lexical" => source === "vector" || source === "lexical",
  );
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRetryableDraftError(error: Error) {
  return error.message.includes("too short");
}
