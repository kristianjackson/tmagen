#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

const DEFAULT_INPUT_DIR = "./data/processed/episodes";
const DEFAULT_ENV_FILE = "./apps/web/.dev.vars";
const TARGET_CHUNK_CHARS = 3200;
const MAX_CHUNK_CHARS = 4200;
const OVERLAP_PARAGRAPHS = 1;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = path.resolve(args.input ?? DEFAULT_INPUT_DIR);
  const envFile = path.resolve(args["env-file"] ?? DEFAULT_ENV_FILE);
  const limit = args.limit ? Number(args.limit) : undefined;
  const dryRun = Boolean(args["dry-run"]);

  if (typeof limit === "number" && Number.isNaN(limit)) {
    throw new Error("--limit must be a number");
  }

  const transcriptFiles = await getTranscriptFiles(inputDir, limit);
  const transcripts = [];

  for (const filePath of transcriptFiles) {
    const transcript = await loadTranscriptRecord(filePath);
    transcripts.push(buildImportRecord(transcript));
  }

  if (transcripts.length === 0) {
    console.log(`No transcript JSON files found in ${inputDir}`);
    return;
  }

  logSummary({
    transcripts,
    mode: dryRun ? "dry-run" : "write",
  });

  if (dryRun) {
    return;
  }

  const env = await loadEnvFile(envFile);
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
          "X-Client-Info": "tmagen/transcript-importer",
        },
      },
    },
  );

  for (const transcript of transcripts) {
    const { data: episodeRow, error: episodeError } = await supabase
      .from("episodes")
      .upsert(
        {
          episode_number: transcript.episodeNumber,
          title: transcript.title,
          slug: transcript.slug,
          source_filename: transcript.sourceFile,
          transcript_text: transcript.text,
          word_count: transcript.wordCount,
          character_count: transcript.characterCount,
          import_status: "ready",
          content_warnings: transcript.contentWarnings,
          deterministic_metadata: transcript.deterministicMetadata,
        },
        { onConflict: "episode_number" },
      )
      .select("id")
      .single();

    if (episodeError || !episodeRow) {
      throw new Error(
        `Failed to upsert episode ${transcript.episodeNumber}: ${episodeError?.message ?? "unknown error"}`,
      );
    }

    const { error: deleteError } = await supabase
      .from("episode_chunks")
      .delete()
      .eq("episode_id", episodeRow.id);

    if (deleteError) {
      throw new Error(
        `Failed to clear chunks for episode ${transcript.episodeNumber}: ${deleteError.message}`,
      );
    }

    const { error: chunkError } = await supabase.from("episode_chunks").insert(
      transcript.chunks.map((chunk) => ({
        episode_id: episodeRow.id,
        chunk_index: chunk.chunkIndex,
        token_estimate: chunk.tokenEstimate,
        content: chunk.content,
        speaker_labels: chunk.speakerLabels,
        character_names: chunk.characterNames,
        fear_slugs: [],
        metadata: chunk.metadata,
      })),
    );

    if (chunkError) {
      throw new Error(
        `Failed to insert chunks for episode ${transcript.episodeNumber}: ${chunkError.message}`,
      );
    }

    console.log(
      `Imported MAG ${String(transcript.episodeNumber).padStart(3, "0")} ${transcript.title} (${transcript.chunks.length} chunks)`,
    );
  }

  console.log(`Imported ${transcripts.length} transcript episodes into Supabase.`);
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);

    if (key === "dry-run") {
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

async function getTranscriptFiles(inputDir, limit) {
  const entries = await readdir(inputDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .sort()
    .slice(0, typeof limit === "number" ? limit : undefined)
    .map((name) => path.join(inputDir, name));
}

async function loadTranscriptRecord(filePath) {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (
    typeof parsed.episodeNumber !== "number" ||
    typeof parsed.title !== "string" ||
    typeof parsed.slug !== "string" ||
    typeof parsed.sourceFile !== "string" ||
    typeof parsed.text !== "string"
  ) {
    throw new Error(`Invalid transcript payload: ${filePath}`);
  }

  return parsed;
}

function buildImportRecord(transcript) {
  const chunks = chunkTranscript(transcript.text);
  const transcriptSha256 = createHash("sha256").update(transcript.text).digest("hex");

  return {
    ...transcript,
    chunks,
    deterministicMetadata: {
      extractor_schema_version: transcript.schemaVersion ?? 1,
      extracted_at: transcript.extractedAt ?? null,
      source_file: transcript.sourceFile,
      transcript_sha256: transcriptSha256,
      chunk_count: chunks.length,
      importer_version: 1,
    },
  };
}

function chunkTranscript(text) {
  const paragraphs = normalizeParagraphs(text);
  const chunks = [];
  let currentParagraphs = [];
  let currentLength = 0;

  for (const paragraph of paragraphs) {
    const paragraphLength = paragraph.length + (currentParagraphs.length > 0 ? 2 : 0);

    if (
      currentParagraphs.length > 0 &&
      currentLength + paragraphLength > MAX_CHUNK_CHARS
    ) {
      finalizeChunk(chunks, currentParagraphs);
      currentParagraphs = currentParagraphs.slice(-OVERLAP_PARAGRAPHS);
      currentLength = joinedLength(currentParagraphs);
    }

    currentParagraphs.push(paragraph);
    currentLength += paragraphLength;

    if (currentLength >= TARGET_CHUNK_CHARS) {
      finalizeChunk(chunks, currentParagraphs);
      currentParagraphs = currentParagraphs.slice(-OVERLAP_PARAGRAPHS);
      currentLength = joinedLength(currentParagraphs);
    }
  }

  finalizeChunk(chunks, currentParagraphs);

  return chunks.map((chunk, index) => ({
    chunkIndex: index,
    tokenEstimate: estimateTokens(chunk.content),
    content: chunk.content,
    speakerLabels: chunk.speakerLabels,
    characterNames: chunk.characterNames,
    metadata: {
      paragraph_count: chunk.paragraphCount,
      character_length: chunk.content.length,
    },
  }));
}

function normalizeParagraphs(text) {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return paragraphs.flatMap((paragraph) => splitLargeParagraph(paragraph));
}

function splitLargeParagraph(paragraph) {
  if (paragraph.length <= MAX_CHUNK_CHARS) {
    return [paragraph];
  }

  const segments = [];
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  let current = "";

  for (const sentence of sentences) {
    if (!sentence) {
      continue;
    }

    const next = current ? `${current} ${sentence}` : sentence;

    if (current && next.length > MAX_CHUNK_CHARS) {
      segments.push(current);
      current = sentence;
      continue;
    }

    current = next;
  }

  if (current) {
    segments.push(current);
  }

  return segments.length > 0 ? segments : [paragraph];
}

function finalizeChunk(chunks, paragraphs) {
  const content = paragraphs.join("\n\n").trim();

  if (!content) {
    return;
  }

  const speakerLabels = extractSpeakerLabels(content);

  if (chunks.at(-1)?.content === content) {
    return;
  }

  chunks.push({
    content,
    paragraphCount: paragraphs.length,
    speakerLabels,
    characterNames: speakerLabels,
  });
}

function extractSpeakerLabels(content) {
  const matches = content.match(/^(?!SFX\b)(?!CONTENT WARNINGS\b)[A-Z][A-Z .'\-]{1,40}$/gm) ?? [];

  return [...new Set(matches.map((match) => match.trim()))].sort();
}

function estimateTokens(content) {
  return Math.ceil(content.length / 4);
}

function joinedLength(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.join("\n\n").length;
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

function logSummary({ transcripts, mode }) {
  const totalChunks = transcripts.reduce((sum, transcript) => sum + transcript.chunks.length, 0);
  const totalWords = transcripts.reduce((sum, transcript) => sum + transcript.wordCount, 0);

  console.log(
    `[${mode}] Prepared ${transcripts.length} transcripts, ${totalChunks} chunks, ${totalWords.toLocaleString()} words.`,
  );

  for (const transcript of transcripts.slice(0, 5)) {
    console.log(
      `  MAG ${String(transcript.episodeNumber).padStart(3, "0")} ${transcript.title}: ${transcript.chunks.length} chunks`,
    );
  }

  if (transcripts.length > 5) {
    console.log(`  ... ${transcripts.length - 5} more episodes`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
