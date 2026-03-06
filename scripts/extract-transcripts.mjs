#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = path.resolve(args.input ?? "./tma_source_transcripts");
  const outputDir = path.resolve(args.output ?? "./data/processed/episodes");
  const overwrite = Boolean(args.overwrite);
  const limit = args.limit ? Number(args.limit) : undefined;

  if (Number.isNaN(limit)) {
    throw new Error("--limit must be a number");
  }

  const inputStat = await stat(inputDir).catch(() => null);
  if (!inputStat || !inputStat.isDirectory()) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  await mkdir(outputDir, { recursive: true });

  const files = (await readdir(inputDir))
    .filter((file) => file.toLowerCase().endsWith(".pdf"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No PDF files found in ${inputDir}`);
  }

  const selectedFiles = typeof limit === "number" ? files.slice(0, limit) : files;
  const manifest = [];

  for (const file of selectedFiles) {
    const filePath = path.join(inputDir, file);
    const episode = parseEpisodeFilename(file);
    const rawText = await extractPdfText(filePath);
    const cleanedText = cleanTranscript(rawText);
    const contentWarnings = extractContentWarnings(cleanedText);
    const slug = `${String(episode.episodeNumber).padStart(3, "0")}-${slugify(episode.title)}`;
    const outputPath = path.join(outputDir, `${slug}.json`);

    const payload = {
      schemaVersion: 1,
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      slug,
      sourceFile: file,
      extractedAt: new Date().toISOString(),
      wordCount: countWords(cleanedText),
      characterCount: cleanedText.length,
      contentWarnings,
      text: cleanedText,
    };

    await writeFile(
      outputPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      overwrite ? undefined : { flag: "wx" }
    );

    manifest.push({
      episodeNumber: payload.episodeNumber,
      title: payload.title,
      slug: payload.slug,
      sourceFile: payload.sourceFile,
      wordCount: payload.wordCount,
      contentWarnings: payload.contentWarnings,
      outputFile: path.relative(process.cwd(), outputPath),
    });

    console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
  }

  const totalWords = manifest.reduce((sum, item) => sum + item.wordCount, 0);
  const manifestPath = path.join(outputDir, "index.json");

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        sourceDirectory: path.relative(process.cwd(), inputDir),
        outputDirectory: path.relative(process.cwd(), outputDir),
        episodeCount: manifest.length,
        totalWords,
        episodes: manifest,
      },
      null,
      2
    )}\n`
  );

  console.log(`Wrote ${path.relative(process.cwd(), manifestPath)}`);
  console.log(`Processed ${manifest.length} episodes with ${totalWords.toLocaleString()} words.`);
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);

    if (key === "overwrite") {
      parsed.overwrite = true;
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

function parseEpisodeFilename(fileName) {
  const stem = fileName.replace(/\.pdf$/i, "");
  const match = stem.match(/MAG\s+(\d{3})\s*-\s*(.+)$/i);

  if (!match) {
    throw new Error(`Could not parse episode number and title from filename: ${fileName}`);
  }

  const episodeNumber = Number(match[1]);
  const title = cleanupTitle(match[2]);

  return { episodeNumber, title };
}

function cleanupTitle(rawTitle) {
  return rawTitle
    .replace(/\s*(?:-|–|—)?\s*transc?ipts?.*$/i, "")
    .replace(/\s*(?:-|–|—)?\s*transcript.*$/i, "")
    .replace(/\s*(?:-|–|—)?\s*re-?formatted.*$/i, "")
    .replace(/\s*(?:-|–|—)?\s*template.*$/i, "")
    .replace(/\s*(?:-|–|—)?\s*converted.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPdfText(filePath) {
  try {
    const { stdout } = await execFileAsync("pdftotext", [filePath, "-"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(
        "pdftotext was not found. Install poppler-utils first: sudo apt-get install -y poppler-utils"
      );
    }

    throw error;
  }
}

function cleanTranscript(rawText) {
  const filteredLines = rawText
    .replace(/\f/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        return true;
      }

      if (/^\d+$/.test(trimmed)) {
        return false;
      }

      if (/^The Magnus Archives\b/i.test(trimmed)) {
        return false;
      }

      if (/^MAG\s*(?:-|–|—)?\s*\d{3}\b/i.test(trimmed)) {
        return false;
      }

      return true;
    });

  return filteredLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractContentWarnings(text) {
  const lines = text.split("\n").map((line) => line.trim());
  const startIndex = lines.findIndex((line) => /^Content Warnings$/i.test(line));

  if (startIndex === -1) {
    return [];
  }

  const warnings = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line) {
      if (warnings.length > 0) {
        break;
      }
      continue;
    }

    if (
      line.startsWith("[") ||
      /^JONATHAN SIMS$/i.test(line) ||
      /^RUSTY QUILL/i.test(line)
    ) {
      break;
    }

    warnings.push(line.replace(/^[•\-−]+\s*/, "").trim());
  }

  return warnings.filter(Boolean);
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
