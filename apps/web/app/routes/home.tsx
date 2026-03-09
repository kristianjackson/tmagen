import { data, Link, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/home";
import type { AppEnv } from "../lib/env.server";
import { listPublishedStorySummaries } from "../lib/published-stories.server";
import {
  buildPublishedStoryPath,
  buildPublishedStoryVersionPath,
} from "../lib/published-stories";
import { createSupabaseAdminClient } from "../lib/supabase/admin.server";
import type { loader as rootLoader } from "../root";

const productPillars = [
  "Grounded in official transcript material instead of blind prompting",
  "Immutable story versions with visible provenance back to source episodes",
  "A private creator loop that can publish exact public versions on purpose",
];

const demoSteps = [
  {
    step: "01",
    title: "Sign in and open the workspace",
    body: "Start from a private creator surface built for briefs, fear selection, canon controls, and retrieval-backed generation.",
  },
  {
    step: "02",
    title: "Generate from the archive",
    body: "Drafts are built from transcript-grounded retrieval packets instead of disconnected prompting, with the source evidence preserved.",
  },
  {
    step: "03",
    title: "Revise without losing history",
    body: "Each revision becomes a child version with stored notes, feedback, prompts, and retrieval context rather than replacing the original.",
  },
  {
    step: "04",
    title: "Publish the exact version you mean",
    body: "Only the chosen version goes public, with stable reader routes and a clear separation between creator controls and reader presentation.",
  },
];

const sourceLinks = [
  {
    label: "Rusty Quill",
    href: "https://rustyquill.com/",
    description: "Official site for the studio behind The Magnus Archives.",
  },
  {
    label: "The Magnus Archives",
    href: "https://rustyquill.com/show/the-magnus-archives/",
    description: "Official show page with listening links and series information.",
  },
  {
    label: "Official transcripts",
    href: "https://rustyquill.com/transcripts/the-magnus-archives",
    description: "Rusty Quill's transcript archive for The Magnus Archives.",
  },
];

export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as AppEnv;
  const adminClient = createSupabaseAdminClient(env);
  const publishedStories = await listPublishedStorySummaries(adminClient, 6);

  return data({
    publishedStories,
    summary: {
      publishedCount: publishedStories.length,
      publicRoutesReady: "project + version URLs",
    },
  });
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "TMAGen | Unofficial Magnus Fan Story Lab" },
    {
      name: "description",
      content:
        "TMAGen is an unofficial fan-made writing platform inspired by The Magnus Archives, built around transcript-grounded generation, revision history, and intentional publishing.",
    },
  ];
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const viewer = rootData?.viewer;
  const buildStatus = [
    { label: "Source corpus", value: "200 episodes ready" },
    { label: "Published stories", value: String(loaderData.summary.publishedCount) },
    { label: "Hosting", value: "Cloudflare Workers" },
    { label: "Public routes", value: loaderData.summary.publicRoutesReady },
  ];

  return (
    <main className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top,rgba(199,75,56,0.22),transparent_60%)]" />
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-16 px-6 py-8 lg:px-10 lg:py-10">
        <header className="flex items-center justify-between rounded-full border border-stone-800/80 bg-stone-950/50 px-5 py-3 backdrop-blur">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-300">
              TMAGen
            </p>
            <p className="mt-1 text-xs text-stone-400">
              Unofficial fan-made writing project inspired by The Magnus Archives
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to={viewer ? "/workspace" : "/auth"}
              className="rounded-full border border-stone-700 bg-stone-900/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-100 transition hover:border-stone-500 hover:bg-stone-900"
            >
              {viewer ? "Open Workspace" : "Sign In"}
            </Link>
            <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-200">
              Creator loop live
            </div>
          </div>
        </header>

        <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
          <div>
            <p className="text-sm uppercase tracking-[0.36em] text-stone-400">
              Built with gratitude for Rusty Quill
            </p>
            <h1 className="mt-5 max-w-4xl font-display text-5xl leading-[1.02] text-stone-50 sm:text-6xl lg:text-7xl">
              A respectful fan-built story lab for The Magnus Archives, grounded in the archive instead of guessing at it.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-stone-300 sm:text-lg">
              TMAGen is an unofficial fan project built out of love for the podcast and the creative
              impact it has had on my life. It uses Rusty Quill&apos;s published Magnus material as the
              grounding layer for generation, revision, provenance, and public reading so the work can
              stay closer to the source it celebrates.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to={viewer ? "/workspace" : "/auth"}
                className="rounded-full border border-amber-400/40 bg-amber-500/15 px-5 py-3 text-sm font-semibold uppercase tracking-[0.22em] text-amber-100 transition hover:border-amber-300/60 hover:bg-amber-500/25"
              >
                {viewer ? `Continue as ${viewer.user.displayName}` : "Create Account"}
              </Link>
              <a
                href="#demo-path"
                className="rounded-full border border-stone-700 bg-stone-950/80 px-5 py-3 text-sm font-semibold uppercase tracking-[0.22em] text-stone-100 transition hover:border-stone-500 hover:bg-stone-900"
              >
                See Demo Path
              </a>
              <a
                href="https://github.com/kristianjackson/tmagen"
                className="rounded-full border border-stone-700 bg-stone-950/80 px-5 py-3 text-sm font-semibold uppercase tracking-[0.22em] text-stone-100 transition hover:border-stone-500 hover:bg-stone-900"
              >
                View Repository
              </a>
            </div>
            <div className="mt-8 flex flex-wrap gap-3">
              {productPillars.map((pillar) => (
                <span
                  key={pillar}
                  className="rounded-full border border-stone-700 bg-stone-900/80 px-4 py-2 text-sm text-stone-200"
                >
                  {pillar}
                </span>
              ))}
            </div>
            <div className="mt-8 max-w-3xl rounded-[1.8rem] border border-amber-500/20 bg-amber-500/10 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-amber-200">
                Source and attribution
              </p>
              <p className="mt-3 text-sm leading-7 text-amber-50/90">
                TMAGen is an unofficial fan-made project. The source material belongs to Rusty Quill
                and <em>The Magnus Archives</em>. This site exists to celebrate that work, not replace
                it.
              </p>
            </div>
          </div>

          <aside className="rounded-[2rem] border border-stone-800/80 bg-stone-950/85 p-6 shadow-2xl shadow-black/30">
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-400">
              What works right now
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {buildStatus.map((item) => (
                <div
                  key={item.label}
                  className="rounded-2xl border border-stone-800 bg-stone-900/80 p-4"
                >
                  <p className="text-xs uppercase tracking-[0.28em] text-stone-500">
                    {item.label}
                  </p>
                  <p className="mt-3 font-display text-2xl text-stone-50">{item.value}</p>
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4">
              <p className="text-xs uppercase tracking-[0.28em] text-amber-200">
                Fastest walkthrough
              </p>
              <p className="mt-3 text-sm leading-7 text-amber-50/90">
                Sign in, create a brief, generate a draft, revise it once, publish the chosen version,
                and open the public reader. The core creator-to-reader loop is live now.
              </p>
            </div>
          </aside>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div
            id="demo-path"
            className="rounded-[2rem] border border-stone-800/80 bg-stone-950/80 p-6"
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-400">
                  Demo path
                </p>
                <h2 className="mt-3 font-display text-3xl text-stone-50">
                  The whole product loop fits in a short, legible walkthrough.
                </h2>
              </div>
              <span className="hidden rounded-full border border-stone-700 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-300 md:inline-flex">
                Under a minute
              </span>
            </div>

            <div className="mt-8 grid gap-4 md:grid-cols-2">
              {demoSteps.map((item) => (
                <article
                  key={item.step}
                  className="rounded-[1.6rem] border border-stone-800 bg-[linear-gradient(145deg,rgba(28,24,22,0.96),rgba(16,16,16,0.92))] p-5"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.34em] text-stone-500">
                    Step {item.step}
                  </p>
                  <h3 className="mt-3 font-display text-2xl text-stone-50">{item.title}</h3>
                  <p className="mt-4 text-sm leading-7 text-stone-300">{item.body}</p>
                </article>
              ))}
            </div>
          </div>

          <div className="rounded-[2rem] border border-stone-800/80 bg-stone-950/80 p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-400">
                  Public archive feed
                </p>
                <h2 className="mt-3 font-display text-3xl text-stone-50">
                  Published stories now come from the real archive, not placeholder cards.
                </h2>
              </div>
              <span className="hidden rounded-full border border-stone-700 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-300 md:inline-flex">
                Read first
              </span>
            </div>

            {loaderData.publishedStories.length > 0 ? (
              <div className="mt-8 grid gap-4">
                {loaderData.publishedStories.map((story) => (
                  <article
                    key={`${story.projectSlug}-${story.versionNumber}`}
                    className="rounded-[1.6rem] border border-stone-800 bg-[linear-gradient(145deg,rgba(32,23,20,0.95),rgba(17,17,17,0.92))] p-5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap gap-2">
                          {story.selectedFearSlugs.map((fearSlug) => (
                            <span
                              key={fearSlug}
                              className="rounded-full bg-stone-800 px-3 py-1 text-xs uppercase tracking-[0.22em] text-amber-200"
                            >
                              {fearSlug}
                            </span>
                          ))}
                        </div>
                        <h3 className="mt-4 font-display text-2xl text-stone-50">{story.title}</h3>
                      </div>

                      <div className="text-right text-xs uppercase tracking-[0.22em] text-stone-400">
                        <p>Published {formatDate(story.publishedAt)}</p>
                        <p className="mt-2">v{story.versionNumber}</p>
                      </div>
                    </div>

                    <p className="mt-4 max-w-2xl text-sm leading-7 text-stone-300">
                      {story.excerpt}
                    </p>

                    <div className="mt-5 flex flex-wrap gap-3">
                      <Link
                        to={buildPublishedStoryPath(story.projectSlug)}
                        className="rounded-full border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-amber-100 transition hover:border-amber-300/60 hover:bg-amber-500/20"
                      >
                        Read story
                      </Link>
                      <Link
                        to={buildPublishedStoryVersionPath(story.projectSlug, story.versionNumber)}
                        className="rounded-full border border-stone-700 bg-stone-950/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-100 transition hover:border-stone-500 hover:bg-stone-900"
                      >
                        Version route
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="mt-8 rounded-[1.6rem] border border-dashed border-stone-700 bg-stone-900/40 p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">
                  Empty archive
                </p>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-stone-300">
                  No story versions have been published yet. The workspace can now publish exact draft
                  versions, so the next public story will appear here automatically once a creator
                  decides a draft is ready for readers.
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
          <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-400">
              Why this exists
            </p>
            <h2 className="mt-3 font-display text-3xl text-stone-50">
              The goal is not to automate affection away. It is to build with enough care that the archive still feels present.
            </h2>
            <p className="mt-5 text-sm leading-7 text-stone-300">
              TMAGen is built to keep the source material visible instead of hiding it behind a black-box
              generation step. Drafts carry retrieval packets, revisions keep lineage, and public stories
              point back to the archive material that shaped them.
            </p>
            <p className="mt-4 text-sm leading-7 text-stone-300">
              That makes this a better writing tool, but it also makes it a better fan project: the work
              it produces is easier to inspect, easier to question, and easier to discuss in relation to
              the world Rusty Quill created.
            </p>
          </article>

          <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-400">
              Source material
            </p>
            <h2 className="mt-3 font-display text-3xl text-stone-50">
              Start with the official work.
            </h2>
            <div className="mt-6 grid gap-4">
              {sourceLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className="rounded-[1.5rem] border border-stone-800 bg-stone-900/80 p-5 transition hover:border-stone-600 hover:bg-stone-900"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.28em] text-amber-300">
                    {link.label}
                  </p>
                  <p className="mt-3 text-sm leading-7 text-stone-300">{link.description}</p>
                  <p className="mt-4 text-xs uppercase tracking-[0.22em] text-stone-500">
                    Open official source
                  </p>
                </a>
              ))}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(new Date(value));
}
