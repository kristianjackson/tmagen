import type { SupabaseClient } from "@supabase/supabase-js";

import type { AppEnv } from "./env.server";

const DEFAULT_MATCH_COUNT = 10;
const DEFAULT_LEXICAL_LIMIT = 12;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const RRF_K = 60;

type RetrievalFilters = {
  episodeId?: string | null;
  fearSlug?: string | null;
  fearSlugs?: string[] | null;
};

type RetrievalOptions = RetrievalFilters & {
  adminClient: SupabaseClient;
  env: AppEnv;
  query: string;
  lexicalLimit?: number;
  matchCount?: number;
};

type RetrievalUsage = {
  promptTokens: number;
  totalTokens: number;
};

type VectorMatch = {
  chunkId: string;
  episodeId: string;
  chunkIndex: number;
  content: string;
  similarity: number | null;
};

type LexicalMatch = {
  chunkId: string;
  lexicalScore: number;
  content: string;
  episodeId: string;
  chunkIndex: number;
  fearSlugs: string[];
};

type ChunkDetail = {
  chunkId: string;
  episodeId: string;
  episodeNumber: number;
  episodeSlug: string;
  episodeTitle: string;
  chunkIndex: number;
  content: string;
  fearSlugs: string[];
};

type RetrievalResult = {
  chunkId: string;
  episodeId: string;
  episodeNumber: number;
  episodeSlug: string;
  episodeTitle: string;
  chunkIndex: number;
  fearSlugs: string[];
  excerpt: string;
  fusedScore: number;
  similarity: number | null;
  lexicalScore: number | null;
  sources: Array<"vector" | "lexical">;
};

export type RetrievalProbe = {
  query: string;
  normalizedQuery: string;
  fearSlug: string | null;
  fearSlugs: string[];
  episodeId: string | null;
  vectorHitCount: number;
  lexicalHitCount: number;
  usage: RetrievalUsage | null;
  warnings: string[];
  results: RetrievalResult[];
};

export async function runChunkRetrievalProbe({
  adminClient,
  env,
  query,
  episodeId,
  fearSlug,
  fearSlugs,
  lexicalLimit = DEFAULT_LEXICAL_LIMIT,
  matchCount = DEFAULT_MATCH_COUNT,
}: RetrievalOptions): Promise<RetrievalProbe> {
  const normalizedQuery = query.trim();
  const warnings: string[] = [];
  const limit = Math.max(lexicalLimit, matchCount, 1);
  const requestedFearSlugs = normalizeFearSlugList({ fearSlug, fearSlugs });

  const [vectorOutcome, lexicalOutcome] = await Promise.all([
    runVectorSearch({
      adminClient,
      env,
      query: normalizedQuery,
      episodeId,
      fearSlugs: requestedFearSlugs,
      matchCount: requestedFearSlugs.length > 1 ? limit * 4 : limit,
    }).catch((error) => {
      warnings.push(`Vector search unavailable: ${formatError(error)}`);
      return { matches: [] as VectorMatch[], usage: null };
    }),
    runLexicalSearch({
      adminClient,
      query: normalizedQuery,
      episodeId,
      fearSlugs: requestedFearSlugs,
      limit: limit * 4,
    }).catch((error) => {
      warnings.push(`Lexical search unavailable: ${formatError(error)}`);
      return [] as LexicalMatch[];
    }),
  ]);

  const lexicalMatches = lexicalOutcome
    .sort((left, right) => right.lexicalScore - left.lexicalScore)
    .slice(0, limit);

  const chunkIds = dedupeStrings([
    ...vectorOutcome.matches.map((match) => match.chunkId),
    ...lexicalMatches.map((match) => match.chunkId),
  ]);
  const chunkDetails = await loadChunkDetails(adminClient, chunkIds);

  if (chunkIds.length > 0 && chunkDetails.size === 0) {
    warnings.push("Chunk hydration returned no rows after retrieval.");
  }

  const fused = fuseMatches({
    chunkDetails,
    fearSlugs: requestedFearSlugs,
    lexicalMatches,
    query: normalizedQuery,
    vectorMatches: vectorOutcome.matches,
  }).slice(0, limit);

  return {
    query,
    normalizedQuery,
    fearSlug: requestedFearSlugs.length === 1 ? requestedFearSlugs[0] : null,
    fearSlugs: requestedFearSlugs,
    episodeId: normalizeOptionalString(episodeId),
    vectorHitCount: vectorOutcome.matches.length,
    lexicalHitCount: lexicalMatches.length,
    usage: vectorOutcome.usage,
    warnings,
    results: fused,
  };
}

async function runVectorSearch({
  adminClient,
  env,
  query,
  episodeId,
  fearSlugs = [],
  matchCount,
}: RetrievalFilters & {
  adminClient: SupabaseClient;
  env: AppEnv;
  query: string;
  matchCount: number;
}) {
  const openAiApiKey = normalizeOptionalString(env.OPENAI_API_KEY);
  const requestedFearSlugs = fearSlugs ?? [];

  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured in the Worker environment.");
  }

  const usageAndEmbedding = await requestEmbedding({
    model: normalizeOptionalString(env.OPENAI_EMBEDDING_MODEL) ?? DEFAULT_EMBEDDING_MODEL,
    openAiApiKey,
    query,
  });
  const filter = buildMatchFilter({
    episodeId,
    fearSlug: requestedFearSlugs.length === 1 ? requestedFearSlugs[0] : null,
  });
  const { data, error } = await adminClient.rpc("match_episode_chunks", {
    filter,
    match_count: matchCount,
    query_embedding: toPgVector(usageAndEmbedding.embedding),
  });

  if (error) {
    throw new Error(`Supabase vector RPC failed: ${error.message}`);
  }

  const matches: VectorMatch[] = (data ?? []).map((row: Record<string, unknown>) => ({
    chunkId: String(row.id),
    episodeId: String(row.episode_id),
    chunkIndex: asInteger(row.chunk_index),
    content: typeof row.content === "string" ? row.content : "",
    similarity: typeof row.similarity === "number" ? row.similarity : null,
  }));

  return {
    matches,
    usage: usageAndEmbedding.usage,
  };
}

async function requestEmbedding({
  model,
  openAiApiKey,
  query,
}: {
  model: string;
  openAiApiKey: string;
  query: string;
}) {
  let response: Response;

  try {
    response = await fetch(OPENAI_EMBEDDINGS_URL, {
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
  } catch (error) {
    throw new Error(`OpenAI embeddings request failed: ${formatError(error)}`);
  }

  if (!response.ok) {
    throw new Error(
      `OpenAI embeddings request failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const embedding = payload.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("OpenAI embeddings response did not include a usable vector.");
  }

  return {
    embedding,
    usage: {
      promptTokens: asInteger(payload.usage?.prompt_tokens),
      totalTokens: asInteger(payload.usage?.total_tokens),
    },
  };
}

async function runLexicalSearch({
  adminClient,
  query,
  episodeId,
  fearSlugs = [],
  limit,
}: RetrievalFilters & {
  adminClient: SupabaseClient;
  query: string;
  limit: number;
}) {
  const searchTerms = extractSearchTerms(query);
  const requestedFearSlugs = fearSlugs ?? [];

  if (searchTerms.length === 0) {
    return [];
  }

  let search = adminClient
    .from("episode_chunks")
    .select("id, episode_id, chunk_index, content, fear_slugs")
    .textSearch("search_vector", query, {
      config: "english",
      type: "websearch",
    })
    .limit(limit);

  if (episodeId) {
    search = search.eq("episode_id", episodeId);
  }

  if (requestedFearSlugs.length === 1) {
    search = search.contains("fear_slugs", [requestedFearSlugs[0]]);
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
        ? row.fear_slugs.filter((value): value is string => typeof value === "string")
        : [],
      lexicalScore: scoreLexicalMatch({
        content: typeof row.content === "string" ? row.content : "",
        query,
        searchTerms,
      }),
    }))
    .filter((row) =>
      requestedFearSlugs.length === 0
        ? true
        : row.fearSlugs.some((fearSlug) => requestedFearSlugs.includes(fearSlug)),
    )
    .filter((row) => row.lexicalScore > 0);
}

async function loadChunkDetails(adminClient: SupabaseClient, chunkIds: string[]) {
  if (chunkIds.length === 0) {
    return new Map<string, ChunkDetail>();
  }

  const { data, error } = await adminClient
    .from("episode_chunks")
    .select(
      "id, episode_id, chunk_index, content, fear_slugs, episodes!inner(episode_number, title, slug)",
    )
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

      return [
        [
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
              ? row.fear_slugs.filter((value): value is string => typeof value === "string")
              : [],
          } satisfies ChunkDetail,
        ],
      ];
    }),
  );
}

function fuseMatches({
  chunkDetails,
  fearSlugs,
  lexicalMatches,
  query,
  vectorMatches,
}: {
  chunkDetails: Map<string, ChunkDetail>;
  fearSlugs: string[];
  lexicalMatches: LexicalMatch[];
  query: string;
  vectorMatches: VectorMatch[];
}) {
  const resultByChunkId = new Map<
    string,
    {
      chunkId: string;
      vectorRank: number | null;
      lexicalRank: number | null;
      similarity: number | null;
      lexicalScore: number | null;
      sources: Set<"vector" | "lexical">;
    }
  >();

  vectorMatches.forEach((match, index) => {
    const current = resultByChunkId.get(match.chunkId) ?? {
      chunkId: match.chunkId,
      lexicalRank: null,
      lexicalScore: null,
      similarity: null,
      sources: new Set<"vector" | "lexical">(),
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
      sources: new Set<"vector" | "lexical">(),
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
        fearSlugs: detail.fearSlugs,
        excerpt: buildExcerpt(detail.content, query),
        fusedScore:
          reciprocalRank(result.vectorRank) +
          reciprocalRank(result.lexicalRank) +
          Math.max(result.similarity ?? 0, 0) * 0.15 +
          Math.max(result.lexicalScore ?? 0, 0) * 0.03,
        similarity: result.similarity,
        lexicalScore: result.lexicalScore,
        sources: Array.from(result.sources),
      } satisfies RetrievalResult;
    })
    .filter((result): result is RetrievalResult => result !== null)
    .sort((left, right) => right.fusedScore - left.fusedScore);
}

function reciprocalRank(rank: number | null) {
  if (!rank || rank < 1) {
    return 0;
  }

  return 1 / (RRF_K + rank);
}

function buildExcerpt(content: string, query: string, maxLength = 320) {
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

function clipWhitespace(value: string, maxLength: number) {
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
}: {
  content: string;
  query: string;
  searchTerms: string[];
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

function countOccurrences(content: string, term: string) {
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

function extractSearchTerms(query: string) {
  return dedupeStrings(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((value) => value.trim())
      .filter((value) => value.length >= 2),
  );
}

function buildMatchFilter({ episodeId, fearSlug }: RetrievalFilters) {
  const filter: Record<string, string> = {};

  if (episodeId) {
    filter.episode_id = episodeId;
  }

  if (fearSlug) {
    filter.fear_slug = fearSlug;
  }

  return filter;
}

function normalizeFearSlugList({
  fearSlug,
  fearSlugs,
}: {
  fearSlug?: string | null;
  fearSlugs?: string[] | null;
}) {
  return dedupeStrings([
    ...(Array.isArray(fearSlugs) ? fearSlugs : []),
    ...(fearSlug ? [fearSlug] : []),
  ].map((value) => value.trim()).filter((value) => value.length > 0));
}

function toPgVector(vector: number[]) {
  return `[${vector.map((value) => Number(value).toString()).join(",")}]`;
}

function normalizeOptionalString(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function asInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  return 0;
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
