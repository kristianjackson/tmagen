import { access, readFile } from "node:fs/promises";

export async function loadScriptEnv({
  envFile,
  includeProcessEnv = true,
}) {
  const fileEnv =
    envFile && (await fileExists(envFile))
      ? await loadEnvFile(envFile)
      : {};

  return includeProcessEnv
    ? {
        ...fileEnv,
        ...readProcessEnv(),
      }
    : fileEnv;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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
    const value = trimmed.slice(separatorIndex + 1).trim();
    env[key] = stripWrappingQuotes(value);
  }

  return env;
}

function readProcessEnv() {
  const env = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }

    env[key] = value;
  }

  return env;
}

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
