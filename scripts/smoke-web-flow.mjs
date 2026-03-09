#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ENV_FILE = "./apps/web/.dev.vars";
const DEFAULT_BASE_URL = "https://tmagen-web.kristian-jackson.workers.dev";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 300_000;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const envFile = path.resolve(args["env-file"] ?? DEFAULT_ENV_FILE);
  const env = await loadEnvFile(envFile);
  const baseUrl = normalizeBaseUrl(args["base-url"] ?? DEFAULT_BASE_URL);
  const keepUser = Boolean(args["keep-user"]);
  const jar = new CookieJar();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const identity = {
    displayName: `Smoke Test ${suffix}`,
    email: `smoke-${suffix}@example.com`,
    password: `SmokeTest!${suffix}`,
    projectSummary: "A smoke-test story used to verify the full TMAGen workspace flow.",
    projectTitle: `Smoke Story ${suffix}`,
    revisionInstructions:
      "Make the opening quieter, remove direct canon references, and sharpen the final Lonely turn.",
    seedPrompt:
      "A deserted waiting room where the tannoy keeps announcing a train that never arrives.",
  };

  let userId = null;

  try {
    console.log(`[smoke] Target: ${baseUrl}`);
    userId = await createTempUser({
      displayName: identity.displayName,
      email: identity.email,
      env,
      password: identity.password,
    });
    console.log(`[smoke] Created temp user ${userId}`);

    const signInResponse = await request(baseUrl, `/auth?next=${encodeURIComponent("/workspace")}`, {
      form: [
        ["intent", "sign-in"],
        ["next", "/workspace"],
        ["email", identity.email],
        ["password", identity.password],
      ],
      jar,
      method: "POST",
      redirect: "manual",
    });

    expectRedirect(signInResponse, "/workspace", "sign in");
    console.log(`[smoke] Signed in and received workspace session cookie`);

    const workspaceResponse = await request(baseUrl, "/workspace", { jar });
    await expectStatus(workspaceResponse, 200, "initial workspace load");
    const workspaceHtml = await workspaceResponse.text();
    ensureIncludes(workspaceHtml, "Creator Workspace", "workspace shell");

    const createProjectResponse = await request(baseUrl, "/workspace", {
      form: [
        ["intent", "create-project"],
        ["title", identity.projectTitle],
        ["summary", identity.projectSummary],
        ["seedPrompt", identity.seedPrompt],
        ["canonMode", "adjacent"],
        ["castPolicy", "cameo"],
        ["visibility", "public"],
        ["selectedFearSlugs", "the-lonely"],
      ],
      jar,
      method: "POST",
      redirect: "manual",
    });

    const createdLocation = expectRedirect(createProjectResponse, "/workspace", "create project");
    const projectSlug = requireQueryParam(createdLocation, "project", "project creation redirect");
    console.log(`[smoke] Created project ${projectSlug}`);

    const selectedProjectHtml = await loadHtml({
      baseUrl,
      jar,
      path: `/workspace?project=${encodeURIComponent(projectSlug)}`,
      step: "load selected project",
    });
    const projectId = requireFormFieldValue({
      fieldName: "projectId",
      html: selectedProjectHtml,
      intent: "generate-draft",
      step: "selected project page",
    });

    const generateDraftResponse = await request(baseUrl, "/workspace", {
      form: [
        ["intent", "generate-draft"],
        ["projectId", projectId],
      ],
      jar,
      method: "POST",
      redirect: "manual",
      timeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
    });

    const generatedLocation = expectRedirect(
      generateDraftResponse,
      "/workspace",
      "generate draft",
    );
    ensureIncludes(generatedLocation, "generated=1", "generate draft redirect");
    console.log(`[smoke] Generated draft v1`);

    const generatedHtml = await loadHtml({
      baseUrl,
      jar,
      path: `/workspace?project=${encodeURIComponent(projectSlug)}`,
      step: "load generated draft",
    });
    ensureIncludes(generatedHtml, "Active Draft", "generated workspace");

    const rootVersionId = requireFormFieldValue({
      fieldName: "versionId",
      html: generatedHtml,
      intent: "revise-draft",
      step: "generated draft page",
    });

    const reviseDraftResponse = await request(baseUrl, "/workspace", {
      form: [
        ["intent", "revise-draft"],
        ["projectId", projectId],
        ["versionId", rootVersionId],
        ["revisionInstructions", identity.revisionInstructions],
      ],
      jar,
      method: "POST",
      redirect: "manual",
      timeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
    });

    const revisedLocation = expectRedirect(reviseDraftResponse, "/workspace", "revise draft");
    ensureIncludes(revisedLocation, "revised=1", "revise draft redirect");
    console.log(`[smoke] Generated revision v2`);

    const revisedHtml = await loadHtml({
      baseUrl,
      jar,
      path: `/workspace?project=${encodeURIComponent(projectSlug)}`,
      step: "load revised draft",
    });
    ensureIncludes(revisedHtml, "Revision brief", "revised workspace");

    const latestVersionId = requireFormFieldValue({
      fieldName: "versionId",
      html: revisedHtml,
      intent: "revise-draft",
      step: "revised draft page",
    });

    const publishResponse = await request(baseUrl, "/workspace", {
      form: [
        ["intent", "publish-version"],
        ["projectId", projectId],
        ["versionId", latestVersionId],
      ],
      jar,
      method: "POST",
      redirect: "manual",
    });

    const publishedLocation = expectRedirect(publishResponse, "/workspace", "publish version");
    const publishedVersion = requireQueryParam(
      publishedLocation,
      "publishedVersion",
      "publish redirect",
    );
    console.log(`[smoke] Published version ${publishedVersion}`);

    const homeHtml = await loadHtml({
      baseUrl,
      jar,
      path: "/",
      step: "load public archive feed",
    });
    ensureIncludes(homeHtml, `/stories/${projectSlug}`, "published story feed card");
    ensureIncludes(
      homeHtml,
      `/stories/${projectSlug}/v/${publishedVersion}`,
      "published story version route",
    );

    const canonicalStoryResponse = await request(
      baseUrl,
      `/stories/${encodeURIComponent(projectSlug)}`,
      { jar },
    );
    await expectStatus(canonicalStoryResponse, 200, "canonical story route");
    ensureIncludes(await canonicalStoryResponse.text(), "Published story reader", "canonical story");

    const versionStoryResponse = await request(
      baseUrl,
      `/stories/${encodeURIComponent(projectSlug)}/v/${publishedVersion}`,
      { jar },
    );
    await expectStatus(versionStoryResponse, 200, "version story route");
    ensureIncludes(await versionStoryResponse.text(), "TMAGen Archive", "version story");

    const unpublishResponse = await request(baseUrl, "/workspace", {
      form: [
        ["intent", "unpublish-version"],
        ["projectId", projectId],
        ["versionId", latestVersionId],
      ],
      jar,
      method: "POST",
      redirect: "manual",
    });

    const unpublishedLocation = expectRedirect(
      unpublishResponse,
      "/workspace",
      "unpublish version",
    );
    ensureIncludes(unpublishedLocation, `unpublishedVersion=${publishedVersion}`, "unpublish redirect");
    console.log(`[smoke] Unpublished version ${publishedVersion}`);

    const homeAfterUnpublish = await loadHtml({
      baseUrl,
      jar,
      path: "/",
      step: "reload archive feed after unpublish",
    });
    ensureExcludes(
      homeAfterUnpublish,
      `/stories/${projectSlug}`,
      "archive feed after unpublish",
    );

    await expectStatus(
      await request(baseUrl, `/stories/${encodeURIComponent(projectSlug)}`, { jar }),
      404,
      "canonical story after unpublish",
    );
    await expectStatus(
      await request(baseUrl, `/stories/${encodeURIComponent(projectSlug)}/v/${publishedVersion}`, {
        jar,
      }),
      404,
      "version story after unpublish",
    );

    const deleteProjectResponse = await request(baseUrl, "/workspace", {
      form: [
        ["intent", "delete-project"],
        ["projectId", projectId],
      ],
      jar,
      method: "POST",
      redirect: "manual",
    });

    const deletedLocation = expectRedirect(deleteProjectResponse, "/workspace", "delete project");
    ensureIncludes(deletedLocation, "projectDeleted=1", "delete project redirect");
    console.log(`[smoke] Deleted project ${projectSlug}`);

    const workspaceAfterDelete = await loadHtml({
      baseUrl,
      jar,
      path: "/workspace",
      step: "workspace after project deletion",
    });
    ensureIncludes(workspaceAfterDelete, "No brief selected", "workspace after deletion");

    console.log("[smoke] Flow passed");
  } finally {
    if (userId && !keepUser) {
      await deleteTempUser({ env, userId });
      console.log(`[smoke] Deleted temp user ${userId}`);
    } else if (userId) {
      console.log(`[smoke] Keeping temp user ${userId}`);
    }
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

    if (key === "help" || key === "keep-user") {
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
  node scripts/smoke-web-flow.mjs [options]

Options:
  --base-url <url>     Base URL for the deployed app. Default: ${DEFAULT_BASE_URL}
  --env-file <path>    Path to the TMAGen env file. Default: ${DEFAULT_ENV_FILE}
  --keep-user          Keep the temporary smoke-test user for inspection
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

async function createTempUser({ displayName, email, env, password }) {
  const response = await fetch(new URL("/auth/v1/admin/users", requireEnv(env, "SUPABASE_URL")), {
    body: JSON.stringify({
      email,
      email_confirm: true,
      password,
      user_metadata: {
        display_name: displayName,
      },
    }),
    headers: {
      apikey: requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
      Authorization: `Bearer ${requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to create temp user (${response.status}): ${(await safeReadText(response)).slice(0, 240)}`,
    );
  }

  const payload = await response.json();

  if (!payload?.id || typeof payload.id !== "string") {
    throw new Error("Supabase admin user creation did not return a user id.");
  }

  return payload.id;
}

async function deleteTempUser({ env, userId }) {
  const response = await fetch(
    new URL(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, requireEnv(env, "SUPABASE_URL")),
    {
      headers: {
        apikey: requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
        Authorization: `Bearer ${requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      method: "DELETE",
      signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to delete temp user (${response.status}): ${(await safeReadText(response)).slice(0, 240)}`,
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

function ensureExcludes(haystack, needle, step) {
  if (haystack.includes(needle)) {
    throw new Error(`Expected ${step} to exclude "${needle}".`);
  }
}

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

main().catch((error) => {
  console.error(`[smoke] ${formatError(error)}`);
  process.exitCode = 1;
});

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
