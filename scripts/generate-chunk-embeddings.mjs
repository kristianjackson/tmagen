#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

const DEFAULT_ENV_FILE = "./apps/web/.dev.vars";
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_CONCURRENCY = 4;
const SUPABASE_PAGE_SIZE = 500;
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

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
  const batchSize = args["batch-size"] ? Number(args["batch-size"]) : DEFAULT_BATCH_SIZE;
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

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("--batch-size must be a positive integer");
  }

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }

  const env = await loadEnvFile(envFile);
  const model = args.model ?? env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_MODEL;
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
          "X-Client-Info": "tmagen/chunk-embedding-generator",
        },
      },
    },
  );

  const episodes = await loadEpisodes({
    supabase,
    episodeNumber,
  });
  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
  const chunks = await loadChunks({
    supabase,
    episodeIds: episodes.map((episode) => episode.id),
  });

  const selectedChunks = chunks
    .filter((chunk) => {
      const episode = episodeById.get(chunk.episodeId);

      if (!episode) {
        return false;
      }

      if (reset) {
        return hasAnyEmbeddingState(chunk);
      }

      return force || needsEmbedding(chunk) || needsFearSync(chunk, episode);
    })
    .slice(0, typeof limit === "number" ? limit : undefined);

  logSelection({
    totalChunks: chunks.length,
    selectedChunks,
    dryRun,
    reset,
    force,
    model,
    batchSize,
    concurrency,
    episodeById,
  });

  if (selectedChunks.length === 0) {
    console.log("No chunks need embedding generation.");
    return;
  }

  if (dryRun) {
    return;
  }

  if (reset) {
    let resetCount = 0;

    for (const chunk of selectedChunks) {
      await resetChunkEmbedding({
        supabase,
        chunkId: chunk.id,
        metadata: chunk.metadata,
      });
      resetCount += 1;
    }

    console.log(`Chunk embedding reset finished: ${resetCount} chunks cleared.`);
    return;
  }

  const openAiApiKey = requireEnv(env, "OPENAI_API_KEY");
  const batches = createBatches(selectedChunks, batchSize);
  const { processedCount, failedCount, aborted, tokenTotal } = await processBatches({
    supabase,
    batches,
    episodeById,
    openAiApiKey,
    model,
    concurrency,
  });

  console.log(
    `Chunk embedding generation finished: ${processedCount} updated, ${failedCount} failed${aborted ? ", batch aborted" : ""}.`,
  );
  console.log(`OpenAI usage: ${formatTokens(tokenTotal)}`);

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
  node scripts/generate-chunk-embeddings.mjs [options]

Options:
  --env-file <path>    Path to the TMAGen env file. Default: ./apps/web/.dev.vars
  --episode <number>   Only process chunks for one episode number
  --limit <number>     Process at most this many chunks
  --model <name>       Override OPENAI_EMBEDDING_MODEL
  --batch-size <n>     Number of chunks per embeddings request. Default: 16
  --concurrency <n>    Number of embeddings requests in parallel. Default: 4
  --force              Regenerate embeddings even if they already exist
  --reset              Clear embeddings and seeded chunk fear tags for selected chunks
  --dry-run            Show which chunks would be processed without calling OpenAI
  --help               Show this message
`);
}

async function loadEpisodes({ supabase, episodeNumber }) {
  let query = supabase
    .from("episodes")
    .select(
      "id, episode_number, title, slug, primary_fear_slug, secondary_fear_slugs, generated_metadata",
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
    primaryFearSlug: episode.primary_fear_slug,
    secondaryFearSlugs: episode.secondary_fear_slugs ?? [],
    generatedMetadata: asRecord(episode.generated_metadata),
  }));
}

async function loadChunks({ supabase, episodeIds }) {
  if (episodeIds.length === 0) {
    return [];
  }

  const rows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("episode_chunks")
      .select("id, episode_id, chunk_index, content, fear_slugs, embedding, metadata")
      .in("episode_id", episodeIds)
      .order("episode_id", { ascending: true })
      .order("chunk_index", { ascending: true })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to load episode chunks: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    rows.push(...data);

    if (data.length < SUPABASE_PAGE_SIZE) {
      break;
    }

    from += SUPABASE_PAGE_SIZE;
  }

  return rows.map((chunk) => ({
    id: chunk.id,
    episodeId: chunk.episode_id,
    chunkIndex: chunk.chunk_index,
    content: chunk.content,
    fearSlugs: chunk.fear_slugs ?? [],
    embedding: normalizeEmbeddingValue(chunk.embedding),
    metadata: asRecord(chunk.metadata),
  }));
}

function logSelection({
  totalChunks,
  selectedChunks,
  dryRun,
  reset,
  force,
  model,
  batchSize,
  concurrency,
  episodeById,
}) {
  const mode = dryRun ? "dry-run" : reset ? "reset" : "write";
  const forceLabel = force ? ", force enabled" : "";
  const actionLabel = reset ? "embedding reset" : `embedding generation with ${model}`;
  const runtimeLabel = reset ? "" : `, batch size ${batchSize}, concurrency ${concurrency}`;
  const selectedEpisodes = new Set(
    selectedChunks.map((chunk) => episodeById.get(chunk.episodeId)?.episodeNumber).filter(Boolean),
  );

  console.log(
    `[${mode}] Loaded ${totalChunks} chunks. Selected ${selectedChunks.length} across ${selectedEpisodes.size} episodes for ${actionLabel}${runtimeLabel}${forceLabel}.`,
  );

  for (const chunk of selectedChunks.slice(0, 5)) {
    const episode = episodeById.get(chunk.episodeId);

    if (!episode) {
      continue;
    }

    console.log(
      `  MAG ${String(episode.episodeNumber).padStart(3, "0")} chunk ${chunk.chunkIndex} (${needsEmbedding(chunk) ? "embed" : "fear-sync"})`,
    );
  }

  if (selectedChunks.length > 5) {
    console.log(`  ... ${selectedChunks.length - 5} more chunks`);
  }
}

function createBatches(items, batchSize) {
  const batches = [];

  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }

  return batches;
}

async function processBatches({
  supabase,
  batches,
  episodeById,
  openAiApiKey,
  model,
  concurrency,
}) {
  let processedCount = 0;
  let failedCount = 0;
  let aborted = false;
  let abortLogged = false;
  let nextIndex = 0;
  let tokenTotal = 0;

  async function processNextBatch() {
    while (nextIndex < batches.length && !aborted) {
      const batch = batches[nextIndex];
      nextIndex += 1;

      try {
        const embeddingsNeeded = batch.filter((chunk) => needsEmbedding(chunk));
        const embeddingsByChunkId = new Map();
        let requestTokens = 0;

        if (embeddingsNeeded.length > 0) {
          const { embeddings, totalTokens } = await requestEmbeddings({
            openAiApiKey,
            model,
            contents: embeddingsNeeded.map((chunk) => chunk.content),
          });

          embeddingsNeeded.forEach((chunk, index) => {
            embeddingsByChunkId.set(chunk.id, embeddings[index]);
          });
          tokenTotal += totalTokens;
          requestTokens = totalTokens;
        }

        await Promise.all(
          batch.map(async (chunk) => {
            const episode = episodeById.get(chunk.episodeId);

            if (!episode) {
              throw new Error(`Missing episode for chunk ${chunk.id}`);
            }

            const shouldWriteEmbedding = embeddingsByChunkId.has(chunk.id);
            const fearSlugs = buildSeedFearSlugs(chunk, episode);
            const metadata = buildChunkMetadata({
              chunk,
              model,
              fearSlugs,
              embeddingGenerated: shouldWriteEmbedding,
            });

            await updateChunk({
              supabase,
              chunkId: chunk.id,
              embedding: shouldWriteEmbedding ? embeddingsByChunkId.get(chunk.id) : undefined,
              fearSlugs,
              metadata,
            });
          }),
        );

        processedCount += batch.length;
        console.log(
          `Updated ${batch.length} chunks (${describeBatch(batch, episodeById)})${requestTokens > 0 ? ` (${formatTokens(requestTokens)})` : ""}`,
        );
      } catch (error) {
        failedCount += batch.length;
        if (shouldAbortBatch(error)) {
          aborted = true;
        }

        console.error(`Failed batch ${describeBatch(batch, episodeById)}: ${formatError(error)}`);

        if (aborted && !abortLogged) {
          abortLogged = true;
          console.error("Aborting chunk embedding generation because the OpenAI failure is systemic.");
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => processNextBatch()));

  return {
    processedCount,
    failedCount,
    aborted,
    tokenTotal,
  };
}

async function requestEmbeddings({ openAiApiKey, model, contents }) {
  let response;

  try {
    response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: contents,
        encoding_format: "float",
      }),
    });
  } catch (error) {
    throw new OpenAiServiceError(
      `OpenAI embeddings request failed before receiving a response: ${formatError(error)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new OpenAiServiceError(
      `OpenAI embeddings request failed (${response.status}): ${body.slice(0, 500)}`,
    );
  }

  const payload = await response.json();
  const embeddings = payload?.data?.map((item) => item.embedding);

  if (!Array.isArray(embeddings) || embeddings.length !== contents.length) {
    throw new Error("OpenAI embeddings response did not match the requested chunk count.");
  }

  return {
    embeddings,
    totalTokens: asNonNegativeInteger(payload?.usage?.total_tokens),
  };
}

async function updateChunk({ supabase, chunkId, embedding, fearSlugs, metadata }) {
  const payload = {
    fear_slugs: fearSlugs,
    metadata,
  };

  if (embedding !== undefined) {
    payload.embedding = embedding;
  }

  const { error } = await supabase
    .from("episode_chunks")
    .update(payload)
    .eq("id", chunkId);

  if (error) {
    throw new Error(`Failed to update chunk ${chunkId}: ${error.message}`);
  }
}

async function resetChunkEmbedding({ supabase, chunkId, metadata }) {
  const { error } = await supabase
    .from("episode_chunks")
    .update({
      embedding: null,
      fear_slugs: [],
      metadata: stripEmbeddingMetadata(metadata),
    })
    .eq("id", chunkId);

  if (error) {
    throw new Error(`Failed to reset chunk ${chunkId}: ${error.message}`);
  }
}

function buildSeedFearSlugs(chunk, episode) {
  const episodeFearSlugs = [
    episode.primaryFearSlug,
    ...episode.secondaryFearSlugs,
  ].filter(Boolean);

  return dedupeStrings([...chunk.fearSlugs, ...episodeFearSlugs]);
}

function buildChunkMetadata({ chunk, model, fearSlugs, embeddingGenerated }) {
  const nextMetadata = {
    ...chunk.metadata,
    episode_fear_slugs: fearSlugs,
  };

  if (embeddingGenerated) {
    nextMetadata.embedding_model = model;
    nextMetadata.embedding_generated_at = new Date().toISOString();
  }

  return nextMetadata;
}

function stripEmbeddingMetadata(metadata) {
  const nextMetadata = { ...metadata };
  delete nextMetadata.embedding_model;
  delete nextMetadata.embedding_generated_at;
  delete nextMetadata.episode_fear_slugs;
  return nextMetadata;
}

function describeBatch(batch, episodeById) {
  const labels = dedupeStrings(
    batch.map((chunk) => {
      const episode = episodeById.get(chunk.episodeId);

      if (!episode) {
        return `chunk ${chunk.chunkIndex}`;
      }

      return `MAG ${String(episode.episodeNumber).padStart(3, "0")}`;
    }),
  );

  if (labels.length <= 3) {
    return labels.join(", ");
  }

  return `${labels[0]} to ${labels.at(-1)}`;
}

function needsEmbedding(chunk) {
  return !hasEmbeddingValue(chunk.embedding);
}

function needsFearSync(chunk, episode) {
  const expectedFearSlugs = buildSeedFearSlugs(chunk, episode);

  if (expectedFearSlugs.length !== chunk.fearSlugs.length) {
    return true;
  }

  return expectedFearSlugs.some((fearSlug, index) => fearSlug !== chunk.fearSlugs[index]);
}

function hasAnyEmbeddingState(chunk) {
  return (
    hasEmbeddingValue(chunk.embedding) ||
    chunk.fearSlugs.length > 0 ||
    "embedding_model" in chunk.metadata ||
    "embedding_generated_at" in chunk.metadata ||
    "episode_fear_slugs" in chunk.metadata
  );
}

function hasEmbeddingValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return typeof value === "string" && value.trim().length > 0;
}

function normalizeEmbeddingValue(value) {
  if (Array.isArray(value) && value.length > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return null;
}

function dedupeStrings(values) {
  const seen = new Set();
  const deduped = [];

  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";

    if (!normalized) {
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
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

function asNonNegativeInteger(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
}

function formatTokens(value) {
  return `${value.toLocaleString()} total tokens`;
}

function shouldAbortBatch(error) {
  return error instanceof OpenAiServiceError;
}

main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
