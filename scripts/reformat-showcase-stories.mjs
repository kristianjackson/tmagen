#!/usr/bin/env node

import path from "node:path";

import { loadScriptEnv } from "./lib/env.mjs";

const DEFAULT_ENV_FILE = "./apps/web/.dev.vars";
const DEFAULT_BASE_URL = "https://tmagen-web.kristian-jackson.workers.dev";
const DEFAULT_EMAIL = "showcase.tmagen@example.com";
const DEFAULT_PASSWORD = "ShowcaseStory!2026";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 300_000;
const DEFAULT_PROJECT_SLUGS = [
  "platform-nine-no-service",
  "the-last-floor-plan",
  "the-last-weather-balloon",
  "no-tape-attached",
];
const DEFAULT_REVISION_INSTRUCTIONS =
  "Reformat this piece into a statement-style presentation familiar to The Magnus Archives while keeping it original. After the title, add a restrained intake/header line in your own wording, rewrite the body as a first-person submitted account, preserve the existing plot and atmosphere, and if it helps, end with a brief archival or site-operator note. Do not parody the show or copy stock phrasing.";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const envFile = path.resolve(args["env-file"] ?? DEFAULT_ENV_FILE);
  await loadScriptEnv({ envFile });

  const baseUrl = normalizeBaseUrl(args["base-url"] ?? DEFAULT_BASE_URL);
  const email = args.email ?? DEFAULT_EMAIL;
  const password = args.password ?? DEFAULT_PASSWORD;
  const projectSlugs = (args.projects ?? DEFAULT_PROJECT_SLUGS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const revisionInstructions = args.revision ?? DEFAULT_REVISION_INSTRUCTIONS;
  const jar = new CookieJar();

  const signInResponse = await request(baseUrl, "/auth?next=%2Fworkspace", {
    form: [
      ["intent", "sign-in"],
      ["next", "/workspace"],
      ["email", email],
      ["password", password],
    ],
    jar,
    method: "POST",
    redirect: "manual",
  });
  expectRedirect(signInResponse, "/workspace", "sign in");

  for (const projectSlug of projectSlugs) {
    const workspaceHtml = await loadHtml({
      baseUrl,
      jar,
      path: `/workspace?project=${encodeURIComponent(projectSlug)}`,
      step: `load workspace for ${projectSlug}`,
    });

    const projectId = requireFormFieldValue({
      fieldName: "projectId",
      html: workspaceHtml,
      intent: "revise-draft",
      step: `workspace for ${projectSlug}`,
    });
    const versionId = requireFormFieldValue({
      fieldName: "versionId",
      html: workspaceHtml,
      intent: "revise-draft",
      step: `workspace for ${projectSlug}`,
    });

    const reviseResponse = await request(baseUrl, "/workspace", {
      form: [
        ["intent", "revise-draft"],
        ["projectId", projectId],
        ["versionId", versionId],
        ["revisionInstructions", revisionInstructions],
      ],
      jar,
      method: "POST",
      redirect: "manual",
      timeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
    });
    expectRedirect(reviseResponse, "/workspace", `revise ${projectSlug}`);
    console.log(`[reformat] Revised ${projectSlug}`);

    const revisedHtml = await loadHtml({
      baseUrl,
      jar,
      path: `/workspace?project=${encodeURIComponent(projectSlug)}`,
      step: `reload revised workspace for ${projectSlug}`,
    });
    const revisedVersionId = requireFormFieldValue({
      fieldName: "versionId",
      html: revisedHtml,
      intent: "revise-draft",
      step: `revised workspace for ${projectSlug}`,
    });

    const publishResponse = await request(baseUrl, "/workspace", {
      form: [
        ["intent", "publish-version"],
        ["projectId", projectId],
        ["versionId", revisedVersionId],
      ],
      jar,
      method: "POST",
      redirect: "manual",
    });
    const location = expectRedirect(publishResponse, "/workspace", `publish ${projectSlug}`);
    const publishedVersion = requireQueryParam(location, "publishedVersion", `publish ${projectSlug}`);
    console.log(`[reformat] Published ${projectSlug} v${publishedVersion}`);

    const storyResponse = await request(baseUrl, `/stories/${encodeURIComponent(projectSlug)}`, {
      jar,
    });
    await expectStatus(storyResponse, 200, `published story for ${projectSlug}`);
  }

  console.log("[reformat] Showcase statement-format pass complete.");
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);

    if (key === "help") {
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
  node scripts/reformat-showcase-stories.mjs [options]

Options:
  --base-url <url>     Base URL for the deployed app. Default: ${DEFAULT_BASE_URL}
  --env-file <path>    Path to the TMAGen env file. Default: ${DEFAULT_ENV_FILE}
  --email <email>      Showcase account email. Default: ${DEFAULT_EMAIL}
  --password <value>   Showcase account password. Default: ${DEFAULT_PASSWORD}
  --projects <list>    Comma-separated project slugs to revise
  --revision <text>    Override the default statement-format revision instructions
  --help               Show this message
`);
}

class CookieJar {
  constructor() {
    this.values = new Map();
  }

  apply(headers) {
    if (this.values.size === 0) {
      return headers;
    }

    headers.set(
      "Cookie",
      [...this.values.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
    );
    return headers;
  }

  store(response) {
    const cookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : splitSetCookieHeader(response.headers.get("set-cookie"));

    for (const cookie of cookies) {
      const [pair] = cookie.split(";", 1);
      const separatorIndex = pair.indexOf("=");

      if (separatorIndex === -1) {
        continue;
      }

      const name = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();

      if (!name) {
        continue;
      }

      this.values.set(name, value);
    }
  }
}

async function request(baseUrl, pathname, options = {}) {
  const {
    form,
    jar,
    method = "GET",
    redirect = "follow",
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;
  const headers = new Headers();

  if (form) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }

  if (jar) {
    jar.apply(headers);
  }

  const response = await fetch(new URL(pathname, baseUrl), {
    body: form ? new URLSearchParams(form) : undefined,
    headers,
    method,
    redirect,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (jar) {
    jar.store(response);
  }

  return response;
}

async function loadHtml({ baseUrl, jar, path: pathname, step }) {
  const response = await request(baseUrl, pathname, { jar });
  await expectStatus(response, 200, step);
  return await response.text();
}

function expectRedirect(response, prefix, step) {
  if (response.status !== 302 && response.status !== 303) {
    throw new Error(`${step} should redirect, got ${response.status}`);
  }

  const location = response.headers.get("location");

  if (!location || !location.startsWith(prefix)) {
    throw new Error(`${step} redirect target was unexpected: ${location ?? "missing"}`);
  }

  return location;
}

async function expectStatus(response, expectedStatus, step) {
  if (response.status !== expectedStatus) {
    const body = await safeReadText(response);
    throw new Error(
      `${step} expected ${expectedStatus}, got ${response.status}. Body preview: ${body.slice(0, 240)}`,
    );
  }
}

function requireFormFieldValue({ fieldName, html, intent, step }) {
  const forms = html.match(
    new RegExp(
      `<form[^>]*>[\\s\\S]*?<input[^>]+name=["']intent["'][^>]+value=["']${escapeRegExp(intent)}["'][\\s\\S]*?<\\/form>`,
      "gi",
    ),
  );

  if (!forms || forms.length === 0) {
    throw new Error(`Could not find form for intent "${intent}" while parsing ${step}.`);
  }

  const valuePattern = new RegExp(
    `name=["']${escapeRegExp(fieldName)}["'][^>]*value=["']([^"']+)["']`,
    "i",
  );

  for (const form of forms) {
    const match = form.match(valuePattern);

    if (match?.[1]) {
      return match[1];
    }
  }

  throw new Error(`Could not find ${fieldName} in the ${intent} form while parsing ${step}.`);
}

function requireQueryParam(location, name, step) {
  const url = new URL(location, "https://tmagen.local");
  const value = url.searchParams.get(name);

  if (!value) {
    throw new Error(`Missing ${name} in ${step}: ${location}`);
  }

  return value;
}

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function splitSetCookieHeader(value) {
  if (!value) {
    return [];
  }

  return value.split(/,(?=[^;]+=[^;]+)/g);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

main().catch((error) => {
  console.error(`[reformat] ${formatError(error)}`);
  process.exitCode = 1;
});

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
