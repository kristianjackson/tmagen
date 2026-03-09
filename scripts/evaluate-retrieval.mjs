#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { loadScriptEnv } from "./lib/env.mjs";

const DEFAULT_ENV_FILE = "./apps/web/.dev.vars";
const DEFAULT_BENCHMARK_FILE = "./scripts/fixtures/retrieval-benchmarks.json";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_LEXICAL_LIMIT = 12;
const DEFAULT_MATCH_COUNT = 10;
const DEFAULT_REPORT_TOP = 5;
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const RRF_K = 60;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const envFile = path.resolve(args["env-file"] ?? DEFAULT_ENV_FILE);
  const benchmarkFile = path.resolve(args.dataset ?? DEFAULT_BENCHMARK_FILE);
  const reportTop = args["report-top"] ? Number(args["report-top"]) : DEFAULT_REPORT_TOP;
  const matchCount = args["match-count"] ? Number(args["match-count"]) : DEFAULT_MATCH_COUNT;
  const lexicalLimit = args["lexical-limit"] ? Number(args["lexical-limit"]) : DEFAULT_LEXICAL_LIMIT;
  const limit = args.limit ? Number(args.limit) : undefined;
  const json = Boolean(args.json);
  const strict = Boolean(args.strict);

  if (!Number.isInteger(reportTop) || reportTop < 1) {
    throw new Error("--report-top must be a positive integer");
  }

  if (!Number.isInteger(matchCount) || matchCount < 1) {
    throw new Error("--match-count must be a positive integer");
  }

  if (!Number.isInteger(lexicalLimit) || lexicalLimit < 1) {
    throw new Error("--lexical-limit must be a positive integer");
  }

  if (typeof limit === "number" && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }

  const env = await loadScriptEnv({ envFile });
  const benchmark = await loadBenchmarkDataset(benchmarkFile);
  const cases = benchmark.cases.slice(0, limit);
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
          "X-Client-Info": "tmagen/retrieval-benchmark",
        },
      },
    },
  );

  const results = [];

  for (const benchmarkCase of cases) {
    const result = await evaluateCase({
      benchmarkCase,
      embeddingModel: env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      env,
      lexicalLimit,
      matchCount,
      supabase,
    });
    results.push(result);
  }

  const summary = summarizeResults(results);

  if (json) {
    console.log(
      JSON.stringify(
        {
          benchmark: {
            schemaVersion: benchmark.schemaVersion,
            description: benchmark.description,
          },
          summary,
          results,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `[retrieval] ${summary.passedCaseCount}/${summary.caseCount} passed · hit@1 ${formatPercent(summary.hitRateAt1)} · hit@3 ${formatPercent(summary.hitRateAt3)} · hit@5 ${formatPercent(summary.hitRateAt5)} · mrr ${summary.meanReciprocalRank.toFixed(3)}`,
  );

  for (const result of results) {
    const prefix = result.passed ? "[pass]" : "[fail]";
    const rankLabel = result.bestExpectedRank ? `best expected rank ${result.bestExpectedRank}` : "expected story missing";
    console.log(
      `${prefix} ${result.id} · ${result.title} · ${rankLabel} · warnings ${result.warningCount}`,
    );

    for (const match of result.topMatches.slice(0, reportTop)) {
      console.log(
        `  #${match.rank} MAG ${String(match.episodeNumber).padStart(3, "0")} ${match.episodeTitle} · fused ${match.fusedScore.toFixed(3)} · ${match.sources.join("+")}`,
      );
    }
  }

  if (strict && summary.passedCaseCount !== summary.caseCount) {
    process.exitCode = 1;
  }
}

async function evaluateCase({
  benchmarkCase,
  embeddingModel,
  env,
  lexicalLimit,
  matchCount,
  supabase,
}) {
  const warnings = [];
  const requestedFearSlugs = Array.isArray(benchmarkCase.fear_slugs)
    ? benchmarkCase.fear_slugs.filter((value) => typeof value === "string" && value.trim().length > 0)
    : [];
  const query = benchmarkCase.query.trim();
  const limit = Math.max(matchCount, lexicalLimit, benchmarkCase.expected_within_rank, DEFAULT_REPORT_TOP);

  const [vectorOutcome, lexicalMatches] = await Promise.all([
    runVectorSearch({
      embeddingModel,
      env,
      fearSlugs: requestedFearSlugs,
      matchCount: requestedFearSlugs.length > 1 ? limit * 4 : limit,
      query,
      supabase,
    }).catch((error) => {
      warnings.push(`Vector search unavailable: ${formatError(error)}`);
      return { matches: [], usage: null };
    }),
    runLexicalSearch({
      fearSlugs: requestedFearSlugs,
      limit: limit * 4,
      query,
      supabase,
    }).catch((error) => {
      warnings.push(`Lexical search unavailable: ${formatError(error)}`);
      return [];
    }),
  ]);

  const topLexicalMatches = lexicalMatches
    .sort((left, right) => right.lexicalScore - left.lexicalScore)
    .slice(0, limit);
  const chunkIds = dedupeStrings([
    ...vectorOutcome.matches.map((match) => match.chunkId),
    ...topLexicalMatches.map((match) => match.chunkId),
  ]);
  const chunkDetails = await loadChunkDetails(supabase, chunkIds);
  const fusedMatches = fuseMatches({
    chunkDetails,
    fearSlugs: requestedFearSlugs,
    lexicalMatches: topLexicalMatches,
    query,
    vectorMatches: vectorOutcome.matches,
  }).slice(0, limit);

  const expectedEpisodeNumbers = benchmarkCase.expected_episode_numbers;
  const expectedRanks = fusedMatches
    .map((match, index) =>
      expectedEpisodeNumbers.includes(match.episodeNumber) ? index + 1 : null,
    )
    .filter((value) => typeof value === "number");
  const bestExpectedRank = expectedRanks.length > 0 ? Math.min(...expectedRanks) : null;

  return {
    id: benchmarkCase.id,
    title: benchmarkCase.title,
    query: benchmarkCase.query,
    fearSlugs: requestedFearSlugs,
    notes: benchmarkCase.notes ?? null,
    expectedEpisodeNumbers,
    expectedWithinRank: benchmarkCase.expected_within_rank,
    bestExpectedRank,
    passed:
      typeof bestExpectedRank === "number" &&
      bestExpectedRank <= benchmarkCase.expected_within_rank,
    topMatches: fusedMatches.map((match, index) => ({
      rank: index + 1,
      episodeNumber: match.episodeNumber,
      episodeTitle: match.episodeTitle,
      episodeSlug: match.episodeSlug,
      chunkIndex: match.chunkIndex,
      chunkId: match.chunkId,
      fusedScore: match.fusedScore,
      lexicalScore: match.lexicalScore,
      similarity: match.similarity,
      sources: match.sources,
    })),
    vectorHitCount: vectorOutcome.matches.length,
    lexicalHitCount: topLexicalMatches.length,
    warningCount: warnings.length,
    warnings,
  };
}

function summarizeResults(results) {
  const caseCount = results.length;
  const hitRateAt = (rank) =>
    caseCount === 0
      ? 0
      : results.filter((result) => result.bestExpectedRank && result.bestExpectedRank <= rank).length /
        caseCount;

  return {
    caseCount,
    passedCaseCount: results.filter((result) => result.passed).length,
    hitRateAt1: hitRateAt(1),
    hitRateAt3: hitRateAt(3),
    hitRateAt5: hitRateAt(5),
    meanReciprocalRank:
      caseCount === 0
        ? 0
        : results.reduce(
            (total, result) =>
              total + (result.bestExpectedRank ? 1 / result.bestExpectedRank : 0),
            0,
          ) / caseCount,
  };
}

async function loadBenchmarkDataset(filePath) {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.cases)) {
    throw new Error("Benchmark dataset is missing a cases array.");
  }

  return {
    schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
    description: typeof parsed.description === "string" ? parsed.description : "",
    cases: parsed.cases.map((value) => normalizeBenchmarkCase(value)),
  };
}

function normalizeBenchmarkCase(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Each benchmark case must be an object.");
  }

  const candidate = value;

  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
    throw new Error("Benchmark case is missing a valid id.");
  }

  if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) {
    throw new Error(`Benchmark case ${candidate.id} is missing a valid title.`);
  }

  if (typeof candidate.query !== "string" || candidate.query.trim().length === 0) {
    throw new Error(`Benchmark case ${candidate.id} is missing a valid query.`);
  }

  if (!Array.isArray(candidate.expected_episode_numbers) || candidate.expected_episode_numbers.length === 0) {
    throw new Error(`Benchmark case ${candidate.id} must define expected_episode_numbers.`);
  }

  const expectedEpisodeNumbers = candidate.expected_episode_numbers.map((episodeNumber) => {
    const parsed = Number(episodeNumber);

    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`Benchmark case ${candidate.id} has an invalid expected episode number.`);
    }

    return parsed;
  });

  const expectedWithinRank = Number(candidate.expected_within_rank);

  if (!Number.isInteger(expectedWithinRank) || expectedWithinRank < 1) {
    throw new Error(`Benchmark case ${candidate.id} must define expected_within_rank.`);
  }

  return {
    id: candidate.id.trim(),
    title: candidate.title.trim(),
    query: candidate.query.trim(),
    fear_slugs: Array.isArray(candidate.fear_slugs)
      ? candidate.fear_slugs
      : [],
    expected_episode_numbers: expectedEpisodeNumbers,
    expected_within_rank: expectedWithinRank,
    notes: typeof candidate.notes === "string" ? candidate.notes.trim() : null,
  };
}

async function runVectorSearch({
  embeddingModel,
  env,
  fearSlugs,
  matchCount,
  query,
  supabase,
}) {
  const usageAndEmbedding = await requestEmbedding({
    model: embeddingModel,
    openAiApiKey: requireEnv(env, "OPENAI_API_KEY"),
    query,
  });
  const filter = buildMatchFilter({
    fearSlug: fearSlugs.length === 1 ? fearSlugs[0] : null,
  });
  const { data, error } = await supabase.rpc("match_episode_chunks", {
    filter,
    match_count: matchCount,
    query_embedding: toPgVector(usageAndEmbedding.embedding),
  });

  if (error) {
    throw new Error(`Supabase vector RPC failed: ${error.message}`);
  }

  return {
    matches: (data ?? []).map((row) => ({
      chunkId: String(row.id),
      episodeId: String(row.episode_id),
      chunkIndex: asInteger(row.chunk_index),
      content: typeof row.content === "string" ? row.content : "",
      similarity: typeof row.similarity === "number" ? row.similarity : null,
    })),
    usage: usageAndEmbedding.usage,
  };
}

async function requestEmbedding({
  model,
  openAiApiKey,
  query,
}) {
  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: query,
      encoding_format: "float",
    }),
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI embeddings request failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  }

  const payload = await response.json();
  const embedding = payload?.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("OpenAI embeddings response did not include a usable vector.");
  }

  return {
    embedding,
    usage: {
      promptTokens: asInteger(payload?.usage?.prompt_tokens),
      totalTokens: asInteger(payload?.usage?.total_tokens),
    },
  };
}

async function runLexicalSearch({
  fearSlugs,
  limit,
  query,
  supabase,
}) {
  const searchTerms = extractSearchTerms(query);

  if (searchTerms.length === 0) {
    return [];
  }

  let search = supabase
    .from("episode_chunks")
    .select("id, episode_id, chunk_index, content, fear_slugs")
    .textSearch("search_vector", query, {
      config: "english",
      type: "websearch",
    })
    .limit(limit);

  if (fearSlugs.length === 1) {
    search = search.contains("fear_slugs", [fearSlugs[0]]);
  }

  const { data, error } = await search;

  if (error) {
    throw new Error(`Supabase lexical query failed: ${error.message}`);
  }

  return (data ?? [])
    .map((row) => ({
      chunkId: String(row.id),
      content: typeof row.content === "string" ? row.content : "",
      episodeId: String(row.episode_id),
      chunkIndex: asInteger(row.chunk_index),
      fearSlugs: Array.isArray(row.fear_slugs)
        ? row.fear_slugs.filter((value) => typeof value === "string")
        : [],
      lexicalScore: scoreLexicalMatch({
        content: typeof row.content === "string" ? row.content : "",
        query,
        searchTerms,
      }),
    }))
    .filter((row) =>
      fearSlugs.length === 0 ? true : row.fearSlugs.some((fearSlug) => fearSlugs.includes(fearSlug)),
    )
    .filter((row) => row.lexicalScore > 0);
}

async function loadChunkDetails(supabase, chunkIds) {
  if (chunkIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from("episode_chunks")
    .select("id, episode_id, chunk_index, content, fear_slugs, episodes!inner(episode_number, title, slug)")
    .in("id", chunkIds);

  if (error) {
    throw new Error(`Failed to hydrate retrieval chunks: ${error.message}`);
  }

  return new Map(
    (data ?? []).flatMap((row) => {
      const episode = Array.isArray(row.episodes) ? row.episodes[0] : row.episodes;

      if (!episode) {
        return [];
      }

      return [[
        String(row.id),
        {
          chunkId: String(row.id),
          episodeId: String(row.episode_id),
          episodeNumber: asInteger(episode.episode_number),
          episodeSlug: typeof episode.slug === "string" ? episode.slug : "",
          episodeTitle: typeof episode.title === "string" ? episode.title : "",
          chunkIndex: asInteger(row.chunk_index),
          content: typeof row.content === "string" ? row.content : "",
          fearSlugs: Array.isArray(row.fear_slugs)
            ? row.fear_slugs.filter((value) => typeof value === "string")
            : [],
        },
      ]];
    }),
  );
}

function fuseMatches({
  chunkDetails,
  fearSlugs,
  lexicalMatches,
  query,
  vectorMatches,
}) {
  const resultByChunkId = new Map();

  vectorMatches.forEach((match, index) => {
    const current = resultByChunkId.get(match.chunkId) ?? {
      chunkId: match.chunkId,
      lexicalRank: null,
      lexicalScore: null,
      similarity: null,
      sources: new Set(),
      vectorRank: null,
    };

    current.vectorRank = index + 1;
    current.similarity = match.similarity;
    current.sources.add("vector");
    resultByChunkId.set(match.chunkId, current);
  });

  lexicalMatches.forEach((match, index) => {
    const current = resultByChunkId.get(match.chunkId) ?? {
      chunkId: match.chunkId,
      lexicalRank: null,
      lexicalScore: null,
      similarity: null,
      sources: new Set(),
      vectorRank: null,
    };

    current.lexicalRank = index + 1;
    current.lexicalScore = match.lexicalScore;
    current.sources.add("lexical");
    resultByChunkId.set(match.chunkId, current);
  });

  return Array.from(resultByChunkId.values())
    .map((result) => {
      const detail = chunkDetails.get(result.chunkId);

      if (!detail) {
        return null;
      }

      if (fearSlugs.length > 0 && !detail.fearSlugs.some((fearSlug) => fearSlugs.includes(fearSlug))) {
        return null;
      }

      return {
        chunkId: result.chunkId,
        episodeId: detail.episodeId,
        episodeNumber: detail.episodeNumber,
        episodeSlug: detail.episodeSlug,
        episodeTitle: detail.episodeTitle,
        chunkIndex: detail.chunkIndex,
        fusedScore:
          reciprocalRank(result.vectorRank) +
          reciprocalRank(result.lexicalRank) +
          Math.max(result.similarity ?? 0, 0) * 0.15 +
          Math.max(result.lexicalScore ?? 0, 0) * 0.03,
        lexicalScore: result.lexicalScore,
        similarity: result.similarity,
        sources: Array.from(result.sources),
        excerpt: buildExcerpt(detail.content, query),
      };
    })
    .filter((result) => result !== null)
    .sort((left, right) => right.fusedScore - left.fusedScore);
}

function reciprocalRank(rank) {
  if (!rank || rank < 1) {
    return 0;
  }

  return 1 / (RRF_K + rank);
}

function buildExcerpt(content, query, maxLength = 240) {
  const normalizedContent = content.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  const searchTerms = [normalizedQuery, ...extractSearchTerms(query)];
  const hitIndex = searchTerms
    .map((term) => normalizedContent.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  if (typeof hitIndex !== "number") {
    return clipWhitespace(content, maxLength);
  }

  const start = Math.max(hitIndex - Math.floor(maxLength * 0.35), 0);
  const end = Math.min(start + maxLength, content.length);
  const excerpt = content.slice(start, end).trim();

  return `${start > 0 ? "..." : ""}${excerpt}${end < content.length ? "..." : ""}`;
}

function clipWhitespace(value, maxLength) {
  const clipped = value.replace(/\s+/g, " ").trim();

  if (clipped.length <= maxLength) {
    return clipped;
  }

  return `${clipped.slice(0, maxLength).trimEnd()}...`;
}

function scoreLexicalMatch({
  content,
  query,
  searchTerms,
}) {
  const normalizedContent = content.toLowerCase();
  const normalizedPhrase = query.trim().toLowerCase();
  let score = 0;

  if (normalizedPhrase.length > 2 && normalizedContent.includes(normalizedPhrase)) {
    score += 4;
  }

  for (const term of searchTerms) {
    const count = countOccurrences(normalizedContent, term);

    if (count === 0) {
      continue;
    }

    score += 1 + Math.min(count - 1, 3) * 0.35;

    if (term.length >= 7) {
      score += 0.15;
    }
  }

  return Number(score.toFixed(3));
}

function countOccurrences(content, term) {
  let count = 0;
  let searchStart = 0;

  while (searchStart < content.length) {
    const index = content.indexOf(term, searchStart);

    if (index === -1) {
      break;
    }

    count += 1;
    searchStart = index + term.length;
  }

  return count;
}

function extractSearchTerms(query) {
  return dedupeStrings(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((value) => value.trim())
      .filter((value) => value.length >= 2),
  );
}

function buildMatchFilter({ fearSlug }) {
  const filter = {};

  if (fearSlug) {
    filter.fear_slug = fearSlug;
  }

  return filter;
}

function toPgVector(vector) {
  return `[${vector.map((value) => Number(value).toString()).join(",")}]`;
}

function dedupeStrings(values) {
  const seen = new Set();
  const deduped = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);

    if (key === "help" || key === "json" || key === "strict") {
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
  node scripts/evaluate-retrieval.mjs [options]

Options:
  --dataset <path>        Path to the benchmark JSON file. Default: ${DEFAULT_BENCHMARK_FILE}
  --env-file <path>       Path to the TMAGen env file. Default: ${DEFAULT_ENV_FILE}
  --match-count <n>       Number of retrieval results to request. Default: ${DEFAULT_MATCH_COUNT}
  --lexical-limit <n>     Number of lexical matches to request. Default: ${DEFAULT_LEXICAL_LIMIT}
  --report-top <n>        Number of top matches to print. Default: ${DEFAULT_REPORT_TOP}
  --limit <n>             Only run the first N benchmark cases
  --json                  Print JSON output instead of text
  --strict                Exit non-zero when any benchmark case fails
  --help                  Show this message
`);
}

function requireEnv(env, key) {
  const value = env[key];

  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }

  return value;
}

function asInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  return 0;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(0)}%`;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

main().catch((error) => {
  console.error(`[retrieval] ${formatError(error)}`);
  process.exitCode = 1;
});
