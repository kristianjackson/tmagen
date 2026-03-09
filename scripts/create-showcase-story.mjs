#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createClient } from "@supabase/supabase-js";

import { loadScriptEnv } from "./lib/env.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_ENV_FILE = "./apps/web/.dev.vars";
const DEFAULT_BASE_URL = "https://tmagen-web.kristian-jackson.workers.dev";
const DEFAULT_CAPTURE_DIR = "/tmp/tmagen-showcase";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 300_000;
const DEFAULT_TITLE = "Platform Nine, No Service";
const DEFAULT_SUMMARY =
  "A late-night commuter hears platform announcements for a train no one else seems to remember, and every attempt to leave the station makes the emptiness feel more deliberate.";
const DEFAULT_SEED_PROMPT =
  "A nearly empty underground station after the last train, with tannoy announcements for a route that does not appear on any map and only seems to be speaking to one passenger.";
const DEFAULT_REVISION =
  "Lean harder into the station's unreal silence, make the narrator's isolation feel gradual rather than immediate, and end on a cleaner final image instead of an explicit explanation.";
const DEFAULT_EMAIL = "showcase.tmagen@example.com";
const DEFAULT_DISPLAY_NAME = "TMAGen Showcase";
const DEFAULT_PASSWORD = "ShowcaseStory!2026";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const envFile = path.resolve(args["env-file"] ?? DEFAULT_ENV_FILE);
  const baseUrl = normalizeBaseUrl(args["base-url"] ?? DEFAULT_BASE_URL);
  const captureDir = path.resolve(args["capture-dir"] ?? DEFAULT_CAPTURE_DIR);
  const env = await loadScriptEnv({ envFile });
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
          "X-Client-Info": "tmagen/showcase-builder",
        },
      },
    },
  );
  const cookieJar = new CookieJar();
  const email = args.email ?? DEFAULT_EMAIL;
  const password = args.password ?? DEFAULT_PASSWORD;
  const title = args.title ?? DEFAULT_TITLE;
  const summary = args.summary ?? DEFAULT_SUMMARY;
  const seedPrompt = args["seed-prompt"] ?? DEFAULT_SEED_PROMPT;
  const revisionInstructions = args.revision ?? DEFAULT_REVISION;
  const displayName = args["display-name"] ?? DEFAULT_DISPLAY_NAME;
  const selectedFearSlugs = (args.fear ?? "the-lonely")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (selectedFearSlugs.length === 0) {
    throw new Error("Provide at least one fear slug.");
  }

  const showcaseUser = await ensureShowcaseUser({
    displayName,
    email,
    password,
    supabase,
  });
  await deleteExistingShowcaseProject({
    supabase,
    title,
    userId: showcaseUser.id,
  });

  const signInResponse = await request(baseUrl, "/auth?next=%2Fworkspace", {
    form: [
      ["intent", "sign-in"],
      ["next", "/workspace"],
      ["email", email],
      ["password", password],
    ],
    jar: cookieJar,
    method: "POST",
    redirect: "manual",
  });
  expectRedirect(signInResponse, "/workspace", "sign in");

  const createProjectResponse = await request(baseUrl, "/workspace", {
    form: [
      ["intent", "create-project"],
      ["title", title],
      ["summary", summary],
      ["seedPrompt", seedPrompt],
      ["canonMode", args["canon-mode"] ?? "adjacent"],
      ["castPolicy", args["cast-policy"] ?? "none"],
      ["visibility", "public"],
      ...selectedFearSlugs.map((fearSlug) => ["selectedFearSlugs", fearSlug]),
    ],
    jar: cookieJar,
    method: "POST",
    redirect: "manual",
  });

  const createdLocation = expectRedirect(createProjectResponse, "/workspace", "create project");
  const projectSlug = requireQueryParam(createdLocation, "project", "create project redirect");
  const workspaceHtml = await loadHtml({
    baseUrl,
    jar: cookieJar,
    path: `/workspace?project=${encodeURIComponent(projectSlug)}`,
    step: "load workspace after create",
  });
  const projectId = requireFormFieldValue({
    fieldName: "projectId",
    html: workspaceHtml,
    intent: "generate-draft",
    step: "workspace after create",
  });

  const generateDraftResponse = await request(baseUrl, "/workspace", {
    form: [
      ["intent", "generate-draft"],
      ["projectId", projectId],
    ],
    jar: cookieJar,
    method: "POST",
    redirect: "manual",
    timeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
  });
  expectRedirect(generateDraftResponse, "/workspace", "generate draft");
  console.log(`[showcase] Generated draft for ${projectSlug}`);

  const generatedHtml = await loadHtml({
    baseUrl,
    jar: cookieJar,
    path: `/workspace?project=${encodeURIComponent(projectSlug)}`,
    step: "load generated draft",
  });
  const rootVersionId = requireFormFieldValue({
    fieldName: "versionId",
    html: generatedHtml,
    intent: "revise-draft",
    step: "generated workspace",
  });

  const reviseDraftResponse = await request(baseUrl, "/workspace", {
    form: [
      ["intent", "revise-draft"],
      ["projectId", projectId],
      ["versionId", rootVersionId],
      ["revisionInstructions", revisionInstructions],
    ],
    jar: cookieJar,
    method: "POST",
    redirect: "manual",
    timeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
  });
  expectRedirect(reviseDraftResponse, "/workspace", "revise draft");
  console.log(`[showcase] Generated revision for ${projectSlug}`);

  const revisedHtml = await loadHtml({
    baseUrl,
    jar: cookieJar,
    path: `/workspace?project=${encodeURIComponent(projectSlug)}`,
    step: "load revised draft",
  });
  ensureIncludes(revisedHtml, "Provenance note", "revised workspace");
  ensureIncludes(revisedHtml, "Fused", "revised workspace");
  const latestVersionId = requireFormFieldValue({
    fieldName: "versionId",
    html: revisedHtml,
    intent: "revise-draft",
    step: "revised workspace",
  });

  const publishResponse = await request(baseUrl, "/workspace", {
    form: [
      ["intent", "publish-version"],
      ["projectId", projectId],
      ["versionId", latestVersionId],
    ],
    jar: cookieJar,
    method: "POST",
    redirect: "manual",
  });
  const publishedLocation = expectRedirect(publishResponse, "/workspace", "publish version");
  const publishedVersion = requireQueryParam(
    publishedLocation,
    "publishedVersion",
    "publish redirect",
  );
  console.log(`[showcase] Published version ${publishedVersion} for ${projectSlug}`);

  const landingHtml = await loadHtml({
    baseUrl,
    jar: cookieJar,
    path: "/",
    step: "load landing page",
  });
  ensureIncludes(landingHtml, `/stories/${projectSlug}`, "landing page");

  const storyPath = `/stories/${encodeURIComponent(projectSlug)}`;
  const versionPath = `${storyPath}/v/${publishedVersion}`;
  const storyResponse = await request(baseUrl, storyPath, { jar: cookieJar });
  await expectStatus(storyResponse, 200, "published story");
  const storyHtml = await storyResponse.text();
  ensureIncludes(storyHtml, "Published story reader", "published story reader");

  await captureScreenshots({
    baseUrl,
    captureDir,
    projectSlug,
    revisedHtml,
    storyPath,
  });

  const manifest = {
    createdAt: new Date().toISOString(),
    baseUrl,
    showcase: {
      displayName,
      email,
      projectId,
      projectSlug,
      publishedVersion: Number(publishedVersion),
      title,
      storyPath,
      versionPath,
    },
    screenshots: {
      landing: path.join(captureDir, "landing-page.png"),
      workspace: path.join(captureDir, "workspace-provenance.png"),
      story: path.join(captureDir, "published-story.png"),
    },
  };

  await writeFile(
    path.join(captureDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  console.log("[showcase] Ready");
  console.log(`[showcase] Landing: ${baseUrl}/`);
  console.log(`[showcase] Story: ${baseUrl}${storyPath}`);
  console.log(`[showcase] Versioned story: ${baseUrl}${versionPath}`);
  console.log(`[showcase] Screenshots: ${captureDir}`);
}

async function captureScreenshots({
  baseUrl,
  captureDir,
  projectSlug,
  revisedHtml,
  storyPath,
}) {
  await rm(captureDir, { force: true, recursive: true });
  await mkdir(captureDir, { recursive: true });

  const landingPath = path.join(captureDir, "landing-page.png");
  const storyImagePath = path.join(captureDir, "published-story.png");
  const workspaceHtmlPath = path.join(captureDir, "workspace.html");
  const workspaceImagePath = path.join(captureDir, "workspace-provenance.png");

  await execFileAsync("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--window-size=1440,2200",
    `--screenshot=${landingPath}`,
    `${baseUrl}/`,
  ]);

  await execFileAsync("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--window-size=1440,2200",
    `--screenshot=${storyImagePath}`,
    `${baseUrl}${storyPath}`,
  ]);

  const renderableWorkspaceHtml = injectBaseHref({
    baseUrl,
    html: revisedHtml.replace(
      "<body",
      `<body data-showcase-project="${escapeHtml(projectSlug)}"`,
    ),
  });
  await writeFile(workspaceHtmlPath, renderableWorkspaceHtml, "utf8");

  await execFileAsync("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--window-size=1440,2600",
    `--screenshot=${workspaceImagePath}`,
    `file://${workspaceHtmlPath}#latest-draft`,
  ]);
}

async function ensureShowcaseUser({ displayName, email, password, supabase }) {
  const user = await findUserByEmail({ email, supabase });

  if (user) {
    const { data, error } = await supabase.auth.admin.updateUserById(user.id, {
      email,
      email_confirm: true,
      password,
      user_metadata: {
        display_name: displayName,
      },
    });

    if (error || !data.user) {
      throw new Error(`Failed to update showcase user: ${error?.message ?? "Unknown error"}`);
    }

    return data.user;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
    user_metadata: {
      display_name: displayName,
    },
  });

  if (error || !data.user) {
    throw new Error(`Failed to create showcase user: ${error?.message ?? "Unknown error"}`);
  }

  return data.user;
}

async function findUserByEmail({ email, supabase }) {
  let page = 1;

  while (page < 10) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 200,
    });

    if (error) {
      throw new Error(`Failed to list auth users: ${error.message}`);
    }

    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());

    if (user) {
      return user;
    }

    if (data.users.length < 200) {
      return null;
    }

    page += 1;
  }

  return null;
}

async function deleteExistingShowcaseProject({ supabase, title, userId }) {
  const slug = slugify(title);
  const { data, error } = await supabase
    .from("story_projects")
    .select("id, title, slug")
    .eq("creator_id", userId);

  if (error) {
    throw new Error(`Failed to check existing showcase project: ${error.message}`);
  }

  const ids = (data ?? [])
    .filter((row) => row.title === title || row.slug === slug)
    .map((row) => row.id)
    .filter((value) => typeof value === "string" && value.length > 0);

  if (ids.length === 0) {
    return;
  }

  const { error: deleteError } = await supabase.from("story_projects").delete().in("id", ids);

  if (deleteError) {
    throw new Error(`Failed to remove existing showcase project: ${deleteError.message}`);
  }
}

function injectBaseHref({ baseUrl, html }) {
  if (html.includes("<base ")) {
    return html;
  }

  return html.replace("<head>", `<head><base href="${baseUrl}/"/>`);
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
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
  node scripts/create-showcase-story.mjs [options]

Options:
  --base-url <url>        Base URL for the deployed app. Default: ${DEFAULT_BASE_URL}
  --env-file <path>       Path to the TMAGen env file. Default: ${DEFAULT_ENV_FILE}
  --capture-dir <path>    Output directory for screenshots + manifest. Default: ${DEFAULT_CAPTURE_DIR}
  --display-name <name>   Showcase account display name. Default: ${DEFAULT_DISPLAY_NAME}
  --email <email>         Showcase account email. Default: ${DEFAULT_EMAIL}
  --password <value>      Showcase account password. Default: ${DEFAULT_PASSWORD}
  --title <text>          Showcase project title
  --summary <text>        Showcase project summary
  --seed-prompt <text>    Seed prompt for generation
  --revision <text>       Revision instructions after v1 generation
  --fear <slug,...>       Comma-separated fear slugs. Default: the-lonely
  --canon-mode <mode>     Canon mode. Default: adjacent
  --cast-policy <mode>    Cast policy. Default: none
  --help                  Show this message
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

function ensureIncludes(haystack, needle, step) {
  if (!haystack.includes(needle)) {
    throw new Error(`Expected ${step} to include "${needle}".`);
  }
}

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function requireEnv(env, key) {
  const value = env[key];

  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }

  return value;
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

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

main().catch((error) => {
  console.error(`[showcase] ${formatError(error)}`);
  process.exitCode = 1;
});

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
