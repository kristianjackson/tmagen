#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { loadScriptEnv } from "./lib/env.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_ENV_FILE = "./apps/web/.dev.vars";
const DEFAULT_BASE_URL = "https://tmagen-web.kristian-jackson.workers.dev";
const DEFAULT_EMAIL = "showcase.tmagen@example.com";
const DEFAULT_PASSWORD = "ShowcaseStory!2026";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_PROJECTS = [
  {
    captureDir: "/tmp/tmagen-showcase",
    slug: "platform-nine-no-service",
  },
  {
    captureDir: "/tmp/tmagen-showcase-spiral",
    slug: "the-last-floor-plan",
  },
  {
    captureDir: "/tmp/tmagen-showcase-vast",
    slug: "the-last-weather-balloon",
  },
  {
    captureDir: "/tmp/tmagen-showcase-meta",
    slug: "no-tape-attached",
  },
];

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
  const jar = new CookieJar();

  const requestedProjects =
    args.projects
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0) ?? DEFAULT_PROJECTS.map((project) => project.slug);
  const captureTargets = DEFAULT_PROJECTS.filter((project) => requestedProjects.includes(project.slug));

  if (captureTargets.length === 0) {
    throw new Error("No showcase projects selected for capture.");
  }

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

  for (const target of captureTargets) {
    const workspaceHtml = await loadHtml({
      baseUrl,
      jar,
      path: `/workspace?project=${encodeURIComponent(target.slug)}`,
      step: `load workspace for ${target.slug}`,
    });
    ensureIncludes(workspaceHtml, "Active Draft", `workspace for ${target.slug}`);
    ensureIncludes(workspaceHtml, "Provenance note", `workspace for ${target.slug}`);

    const storyPath = `/stories/${encodeURIComponent(target.slug)}`;
    const storyResponse = await request(baseUrl, storyPath, { jar });
    await expectStatus(storyResponse, 200, `story route for ${target.slug}`);
    const storyHtml = await storyResponse.text();
    const title = readFirstMatch(storyHtml, /<h1[^>]*>([^<]+)<\/h1>/i) ?? target.slug;
    const versionNumber = Number.parseInt(
      readFirstMatch(storyHtml, /Version:<\/span>\s*<!-- -->\s*(\d+)/i) ?? "",
      10,
    );

    await captureScreenshots({
      baseUrl,
      captureDir: target.captureDir,
      projectSlug: target.slug,
      storyPath,
      workspaceHtml,
    });

    const manifest = {
      capturedAt: new Date().toISOString(),
      baseUrl,
      showcase: {
        projectSlug: target.slug,
        storyPath,
        title,
        versionNumber: Number.isFinite(versionNumber) ? versionNumber : null,
        versionPath:
          Number.isFinite(versionNumber) && versionNumber > 0
            ? `${storyPath}/v/${versionNumber}`
            : null,
      },
      screenshots: {
        landing: path.join(target.captureDir, "landing-page.png"),
        workspace: path.join(target.captureDir, "workspace-provenance.png"),
        story: path.join(target.captureDir, "published-story.png"),
      },
    };

    await writeFile(
      path.join(target.captureDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    console.log(`[capture] Refreshed ${target.slug} -> ${target.captureDir}`);
  }
}

async function captureScreenshots({
  baseUrl,
  captureDir,
  projectSlug,
  storyPath,
  workspaceHtml,
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
    html: workspaceHtml.replace(
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
  node scripts/capture-showcase-screenshots.mjs [options]

Options:
  --base-url <url>     Base URL for the deployed app. Default: ${DEFAULT_BASE_URL}
  --env-file <path>    Path to the TMAGen env file. Default: ${DEFAULT_ENV_FILE}
  --email <email>      Showcase account email. Default: ${DEFAULT_EMAIL}
  --password <value>   Showcase account password. Default: ${DEFAULT_PASSWORD}
  --projects <list>    Comma-separated showcase project slugs to capture
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

function ensureIncludes(haystack, needle, step) {
  if (!haystack.includes(needle)) {
    throw new Error(`Expected ${step} to include "${needle}".`);
  }
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

function injectBaseHref({ baseUrl, html }) {
  if (html.includes("<base ")) {
    return html;
  }

  return html.replace("<head>", `<head><base href="${baseUrl}/"/>`);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readFirstMatch(value, pattern) {
  const match = value.match(pattern);
  return match?.[1]?.trim() ?? null;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

main().catch((error) => {
  console.error(`[capture] ${formatError(error)}`);
  process.exitCode = 1;
});

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
