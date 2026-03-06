import { data, Form, Link, redirect } from "react-router";

import type { Route } from "./+types/account";
import type { AppEnv } from "../lib/env.server";
import { getViewer } from "../lib/viewer.server";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "TMAGen | Workspace" },
    {
      name: "description",
      content:
        "Protected TMAGen workspace showing the authenticated viewer and the first live data fetched from Supabase.",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as AppEnv;
  const { responseHeaders, supabase, viewer } = await getViewer({ env, request });

  if (!viewer) {
    return redirect("/auth?next=/account", { headers: responseHeaders });
  }

  const { data: fears } = await supabase
    .from("fears")
    .select("slug, name, description")
    .order("sort_order", { ascending: true });

  return data(
    {
      fears: fears ?? [],
      viewer,
    },
    { headers: responseHeaders },
  );
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const { fears, viewer } = loaderData;

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-6 py-10 lg:px-10">
      <div className="flex items-center justify-between rounded-full border border-stone-800/80 bg-stone-950/60 px-5 py-3 backdrop-blur">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-300">
            TMAGen Workspace
          </p>
          <p className="mt-1 text-xs text-stone-400">
            Authenticated route backed by Supabase
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="rounded-full border border-stone-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-200 transition hover:border-stone-500"
          >
            Public Feed
          </Link>
          <Form method="post" action="/logout">
            <button
              type="submit"
              className="rounded-full border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-red-100 transition hover:border-red-400/50 hover:bg-red-500/20"
            >
              Sign Out
            </button>
          </Form>
        </div>
      </div>

      <section className="mt-10 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <aside className="rounded-[2rem] border border-stone-800/80 bg-stone-950/80 p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
            Current viewer
          </p>
          <h1 className="mt-4 font-display text-4xl text-stone-50">
            {viewer.profile?.displayName ?? viewer.user.displayName}
          </h1>
          <div className="mt-6 space-y-3 text-sm text-stone-300">
            <p>
              <span className="text-stone-500">Email:</span> {viewer.user.email ?? "No email"}
            </p>
            <p>
              <span className="text-stone-500">Handle:</span>{" "}
              {viewer.profile?.handle ? `@${viewer.profile.handle}` : "Not set yet"}
            </p>
            <p>
              <span className="text-stone-500">Profile source:</span>{" "}
              {viewer.profile ? "Loaded from `profiles`" : "Fallback from auth metadata"}
            </p>
          </div>

          <div className="mt-8 rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.28em] text-amber-200">
              What this proves
            </p>
            <p className="mt-3 text-sm leading-7 text-amber-50/90">
              Supabase auth is issuing a working session, the protected route is verifying it on the
              server, and the app can read product data with that authenticated context.
            </p>
          </div>
        </aside>

        <section className="rounded-[2rem] border border-stone-800/80 bg-stone-950/80 p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                First live dataset
              </p>
              <h2 className="mt-3 font-display text-3xl text-stone-50">
                Fear taxonomy from the Supabase database
              </h2>
            </div>
            <span className="rounded-full border border-stone-700 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-300">
              {fears.length} records
            </span>
          </div>

          <div className="mt-8 grid gap-3 md:grid-cols-2">
            {fears.map((fear) => (
              <article
                key={fear.slug}
                className="rounded-2xl border border-stone-800 bg-stone-900/75 p-4"
              >
                <p className="text-xs uppercase tracking-[0.24em] text-stone-500">{fear.slug}</p>
                <h3 className="mt-3 font-display text-2xl text-stone-50">{fear.name}</h3>
                <p className="mt-3 text-sm leading-7 text-stone-300">{fear.description}</p>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
