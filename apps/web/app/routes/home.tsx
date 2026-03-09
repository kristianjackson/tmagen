import { data, Link, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/home";
import type { AppEnv } from "../lib/env.server";
import {
  listPublishedStorySummaries,
} from "../lib/published-stories.server";
import {
  buildPublishedStoryPath,
  buildPublishedStoryVersionPath,
} from "../lib/published-stories";
import { createSupabaseAdminClient } from "../lib/supabase/admin.server";
import type { loader as rootLoader } from "../root";

const productPillars = [
  "Transcript-grounded generation instead of blind prompting",
  "Immutable story versions with provenance back to source episodes",
  "A public archive feed plus a private creator workspace",
];

const workflow = [
  {
    step: "01",
    title: "Prepare the archive",
    body: "Extract PDFs, clean transcript text, generate metadata, and chunk the corpus for search and embeddings.",
  },
  {
    step: "02",
    title: "Shape the brief",
    body: "Users choose canon mode, cast policy, fears, prompt seed, and whether the concept should be random.",
  },
  {
    step: "03",
    title: "Publish intentionally",
    body: "Drafts stay private until a specific version is published, then the archive gets a stable reader route and current public link.",
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
    { title: "TMAGen | Archive-Born Fan Fiction" },
    {
      name: "description",
      content:
        "TMAGen is a Cloudflare-hosted, Supabase-backed writing platform for archive-aware fan fiction inspired by The Magnus Archives.",
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
              Cloudflare-hosted archive fiction engine
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
              Publishing live
            </div>
          </div>
        </header>

        <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
          <div>
            <p className="text-sm uppercase tracking-[0.36em] text-stone-400">
              Archive-born drafting
            </p>
            <h1 className="mt-5 max-w-4xl font-display text-5xl leading-[1.02] text-stone-50 sm:text-6xl lg:text-7xl">
              Build fan fiction from a curated horror archive, then publish the exact version that earns it.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-stone-300 sm:text-lg">
              TMAGen is a multiuser writing platform where transcript-grounded retrieval, explicit fear
              selection, canon controls, revision history, and public story publication are part of the
              product model rather than bolted on afterward.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to={viewer ? "/workspace" : "/auth"}
                className="rounded-full border border-amber-400/40 bg-amber-500/15 px-5 py-3 text-sm font-semibold uppercase tracking-[0.22em] text-amber-100 transition hover:border-amber-300/60 hover:bg-amber-500/25"
              >
                {viewer ? `Continue as ${viewer.user.displayName}` : "Create Account"}
              </Link>
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
          </div>

          <aside className="rounded-[2rem] border border-stone-800/80 bg-stone-950/85 p-6 shadow-2xl shadow-black/30">
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-400">
              Build status
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
                Immediate goal
              </p>
              <p className="mt-3 text-sm leading-7 text-amber-50/90">
                Move from revision into strong public reading surfaces: publish exact versions, keep
                reader URLs stable, and separate creator controls from public presentation.
              </p>
            </div>
          </aside>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
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

          <div className="space-y-4">
            {workflow.map((item) => (
              <article
                key={item.step}
                className="rounded-[1.8rem] border border-stone-800/80 bg-stone-950/75 p-6"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.34em] text-stone-500">
                  Step {item.step}
                </p>
                <h3 className="mt-3 font-display text-3xl text-stone-50">{item.title}</h3>
                <p className="mt-4 text-sm leading-7 text-stone-300">{item.body}</p>
              </article>
            ))}
          </div>
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
