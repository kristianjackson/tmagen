import { data, Link, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/story-reader";
import { createSupabaseAdminClient } from "../lib/supabase/admin.server";
import type { AppEnv } from "../lib/env.server";
import type { loader as rootLoader } from "../root";
import {
  loadPublishedStory,
} from "../lib/published-stories.server";
import {
  buildPublishedStoryPath,
  buildPublishedStoryVersionPath,
} from "../lib/published-stories";

const sourceLinks = [
  {
    label: "Rusty Quill",
    href: "https://rustyquill.com/",
  },
  {
    label: "The Magnus Archives",
    href: "https://rustyquill.com/show/the-magnus-archives/",
  },
  {
    label: "Official transcripts",
    href: "https://rustyquill.com/transcripts/the-magnus-archives",
  },
];

export async function loader({ context, params }: Route.LoaderArgs) {
  const env = context.cloudflare.env as AppEnv;
  const adminClient = createSupabaseAdminClient(env);
  const storySlug = params.storySlug?.trim();
  const versionNumber = parseVersionNumber(params.versionNumber);

  if (!storySlug) {
    throw data({ message: "Story not found." }, { status: 404 });
  }

  const story = await loadPublishedStory({
    adminClient,
    storySlug,
    versionNumber,
  });

  if (!story) {
    throw data({ message: "Story not found." }, { status: 404 });
  }

  return data({
    story,
    canonicalPath: buildPublishedStoryPath(story.projectSlug),
    versionPath: buildPublishedStoryVersionPath(story.projectSlug, story.versionNumber),
  });
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) {
    return [
      { title: "TMAGen | Story Not Found" },
      { name: "description", content: "The requested published TMAGen story could not be found." },
    ];
  }

  return [
    { title: `${loaderData.story.title} | TMAGen` },
    {
      name: "description",
      content:
        loaderData.story.projectSummary ??
        `Published TMAGen story version ${loaderData.story.versionNumber} from an unofficial fan-made project inspired by The Magnus Archives.`,
    },
  ];
}

export default function StoryReader({ loaderData }: Route.ComponentProps) {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const viewer = rootData?.viewer;
  const paragraphs = splitStoryBody(loaderData.story.contentMarkdown);
  const isCanonicalPath = loaderData.canonicalPath === loaderData.versionPath;

  return (
    <main className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top,rgba(199,75,56,0.20),transparent_60%)]" />
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-10 px-6 py-8 lg:px-10 lg:py-10">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-full border border-stone-800/80 bg-stone-950/60 px-5 py-3 backdrop-blur">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-300">
              TMAGen Archive
            </p>
            <p className="mt-1 text-xs text-stone-400">
              Published story reader
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="rounded-full border border-stone-700 bg-stone-900/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-100 transition hover:border-stone-500 hover:bg-stone-900"
            >
              Archive Feed
            </Link>
            <Link
              to={viewer ? "/workspace" : "/auth"}
              className="rounded-full border border-amber-400/40 bg-amber-500/15 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-amber-100 transition hover:border-amber-300/60 hover:bg-amber-500/25"
            >
              {viewer ? "Open Workspace" : "Sign In"}
            </Link>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/85 p-7 shadow-2xl shadow-black/30">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap gap-2">
                  {loaderData.story.selectedFearSlugs.map((fearSlug) => (
                    <span
                      key={fearSlug}
                      className="rounded-full border border-stone-700 bg-stone-900/80 px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-stone-200"
                    >
                      {fearSlug}
                    </span>
                  ))}
                </div>
                <h1 className="mt-5 font-display text-5xl leading-tight text-stone-50 sm:text-6xl">
                  {loaderData.story.title}
                </h1>
                {loaderData.story.projectSummary ? (
                  <p className="mt-5 max-w-3xl text-base leading-8 text-stone-300">
                    {loaderData.story.projectSummary}
                  </p>
                ) : null}
              </div>

              <div className="rounded-[1.5rem] border border-stone-800 bg-stone-900/75 p-4 text-sm text-stone-300">
                <p>
                  <span className="text-stone-500">Published:</span>{" "}
                  {formatDate(loaderData.story.publishedAt)}
                </p>
                <p className="mt-2">
                  <span className="text-stone-500">Version:</span>{" "}
                  {loaderData.story.versionNumber}
                </p>
                <p className="mt-2">
                  <span className="text-stone-500">Canon mode:</span>{" "}
                  {loaderData.story.canonMode}
                </p>
              </div>
            </div>

            <div className="mt-8 space-y-6 text-[17px] leading-9 text-stone-100">
              {paragraphs.map((paragraph) => (
                <p key={paragraph.slice(0, 48)}>{paragraph}</p>
              ))}
            </div>
          </article>

          <aside className="space-y-6">
            <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                Story Details
              </p>
              <div className="mt-4 grid gap-3">
                <ReaderStat label="Cast policy" value={loaderData.story.castPolicy} />
                <ReaderStat
                  label="Published route"
                  value={isCanonicalPath ? "canonical" : "versioned"}
                />
                <ReaderStat
                  label="Created"
                  value={formatDate(loaderData.story.createdAt)}
                />
              </div>

              {!isCanonicalPath ? (
                <div className="mt-5">
                  <Link
                    to={loaderData.canonicalPath}
                    className="rounded-[1.2rem] border border-stone-800 bg-stone-900/80 px-4 py-3 text-sm text-stone-200 transition hover:border-stone-600"
                  >
                    Open canonical story URL
                  </Link>
                </div>
              ) : null}
            </article>

            {loaderData.story.revisionNotes ? (
              <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                  Editorial Note
                </p>
                <p className="mt-4 text-sm leading-7 text-stone-300">
                  This published version came through the workspace revision flow before it was made
                  public.
                </p>
              </article>
            ) : null}

            <article className="rounded-[2rem] border border-amber-500/20 bg-amber-500/10 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.32em] text-amber-200">
                Source and attribution
              </p>
              <p className="mt-4 text-sm leading-7 text-amber-50/90">
                TMAGen is an unofficial fan-made project inspired by <em>The Magnus Archives</em>.
                The original world and source material belong to Rusty Quill.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {sourceLinks.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    className="rounded-full border border-amber-400/30 bg-stone-950/20 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-100 transition hover:border-amber-300/60 hover:bg-stone-950/35"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </article>
          </aside>
        </section>
      </div>
    </main>
  );
}

function splitStoryBody(markdown: string) {
  const normalized = markdown.trim();
  const lines = normalized.startsWith("# ") ? normalized.split("\n").slice(1).join("\n") : normalized;

  return lines
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function parseVersionNumber(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function ReaderStat({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-[1.2rem] border border-stone-800 bg-stone-900/80 p-4">
      <p className="text-[11px] uppercase tracking-[0.24em] text-stone-500">{label}</p>
      <p className="mt-3 font-display text-2xl text-stone-50">{value}</p>
    </article>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
