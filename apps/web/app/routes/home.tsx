import type { Route } from "./+types/home";
import { Link, useRouteLoaderData } from "react-router";

import type { loader as rootLoader } from "../root";

const publicStories = [
  {
    title: "A Statement on the Shape of Empty Rooms",
    tag: "The Lonely",
    summary:
      "A low-burn archive entry that starts as housing anxiety and ends in a room that edits people out of memory.",
  },
  {
    title: "Interdepartmental Notes Regarding Stairwell C",
    tag: "The Spiral",
    summary:
      "A canon-adjacent office horror thread told through memos, taped addenda, and one witness who keeps changing names.",
  },
  {
    title: "The Last Passenger on the District Line",
    tag: "The End",
    summary:
      "A public archive draft that mixes commuter dread, inevitability, and a narrator who already knows where the train stops.",
  },
];

const productPillars = [
  "Transcript-grounded generation instead of blind prompting",
  "Immutable story versions with provenance back to source episodes",
  "A public archive feed plus a private creator workspace",
];

const buildStatus = [
  { label: "Source corpus", value: "200 PDFs ready" },
  { label: "Corpus size", value: "~728k words sampled" },
  { label: "Hosting", value: "Cloudflare Workers" },
  { label: "Backend", value: "Supabase + pgvector" },
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
    title: "Generate with provenance",
    body: "Every story version stores the prompt snapshot, the retrieved episode material, and the exact draft output.",
  },
];

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

export default function Home() {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const viewer = rootData?.viewer;

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
              to={viewer ? "/account" : "/auth"}
              className="rounded-full border border-stone-700 bg-stone-900/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-100 transition hover:border-stone-500 hover:bg-stone-900"
            >
              {viewer ? "Open Workspace" : "Sign In"}
            </Link>
            <div className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-amber-200">
              Foundation pass
            </div>
          </div>
        </header>

        <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
          <div>
            <p className="text-sm uppercase tracking-[0.36em] text-stone-400">
              Archive-born drafting
            </p>
            <h1 className="mt-5 max-w-4xl font-display text-5xl leading-[1.02] text-stone-50 sm:text-6xl lg:text-7xl">
              Build fan fiction from a curated horror archive, not from vibes.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-stone-300 sm:text-lg">
              TMAGen is being built as a multiuser writing platform where transcript-grounded retrieval,
              explicit fear selection, canon controls, and versioned rewrites are part of the product
              model rather than bolted on after the fact.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to={viewer ? "/account" : "/auth"}
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
                Get transcript extraction, the Supabase schema, and the Cloudflare web shell locked down
                before the generation workflow starts to sprawl.
              </p>
            </div>
          </aside>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-[2rem] border border-stone-800/80 bg-stone-950/80 p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-400">
                  Public archive preview
                </p>
                <h2 className="mt-3 font-display text-3xl text-stone-50">
                  The anonymous landing experience should feel like a curated feed, not a blank prompt box.
                </h2>
              </div>
              <span className="hidden rounded-full border border-stone-700 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-300 md:inline-flex">
                Browse first
              </span>
            </div>

            <div className="mt-8 grid gap-4">
              {publicStories.map((story) => (
                <article
                  key={story.title}
                  className="rounded-[1.6rem] border border-stone-800 bg-[linear-gradient(145deg,rgba(32,23,20,0.95),rgba(17,17,17,0.92))] p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="font-display text-2xl text-stone-50">{story.title}</h3>
                    <span className="rounded-full bg-stone-800 px-3 py-1 text-xs uppercase tracking-[0.22em] text-amber-200">
                      {story.tag}
                    </span>
                  </div>
                  <p className="mt-4 max-w-2xl text-sm leading-7 text-stone-300">{story.summary}</p>
                </article>
              ))}
            </div>
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
