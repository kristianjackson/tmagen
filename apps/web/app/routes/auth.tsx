import { data, Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/auth";
import {
  buildAuthCallbackUrl,
  getSafeNextPath,
} from "../lib/auth-redirect";
import type { AppEnv } from "../lib/env.server";
import { createSupabaseServerClient } from "../lib/supabase/server";
import { getViewer } from "../lib/viewer.server";

type AuthActionData = {
  error?: string;
  success?: string;
  fields?: {
    displayName?: string;
    email?: string;
    next?: string;
  };
  intent?: "sign-in" | "sign-up";
};

export function meta({}: Route.MetaArgs) {
  return [
    { title: "TMAGen | Sign In" },
    {
      name: "description",
      content:
        "Sign in to TMAGen to manage your profile, review archive-grounded stories, and start generating drafts.",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as AppEnv;
  const url = new URL(request.url);
  const next = getSafeNextPath(url.searchParams.get("next"));
  const redirectError = normalizeQueryMessage(url.searchParams.get("error"));
  const { responseHeaders, viewer } = await getViewer({ env, request });

  if (viewer) {
    return redirect(next, { headers: responseHeaders });
  }

  return data({ next, redirectError }, { headers: responseHeaders });
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as AppEnv;
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient({
    env,
    request,
    responseHeaders,
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const displayName = String(formData.get("displayName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = getSafeNextPath(formData.get("next"));

  if (!email || !password) {
    return data<AuthActionData>(
      {
        error: "Email and password are both required.",
        fields: { displayName, email, next },
        intent: intent === "sign-up" ? "sign-up" : "sign-in",
      },
      { headers: responseHeaders, status: 400 },
    );
  }

  if (intent === "sign-up") {
    if (displayName.length < 2) {
      return data<AuthActionData>(
        {
          error: "Display name must be at least 2 characters long.",
          fields: { displayName, email, next },
          intent: "sign-up",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { data: signUpData, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          display_name: displayName,
        },
        emailRedirectTo: buildAuthCallbackUrl(request, next),
      },
    });

    if (error) {
      return data<AuthActionData>(
        {
          error: error.message,
          fields: { displayName, email, next },
          intent: "sign-up",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    if (signUpData.session) {
      return redirect(next, { headers: responseHeaders });
    }

    return data<AuthActionData>(
      {
        success:
          "Account created. If email confirmations are enabled in Supabase, check your inbox before signing in.",
        fields: { email, next },
        intent: "sign-up",
      },
      { headers: responseHeaders },
    );
  }

  if (intent === "sign-in") {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return data<AuthActionData>(
        {
          error: error.message,
          fields: { email, next },
          intent: "sign-in",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    return redirect(next, { headers: responseHeaders });
  }

  return data<AuthActionData>(
    {
      error: "Unknown authentication action.",
      fields: { displayName, email, next },
    },
    { headers: responseHeaders, status: 400 },
  );
}

export default function Auth({ actionData, loaderData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const errorMessage = actionData?.error ?? loaderData.redirectError;
  const formAction = `/auth?next=${encodeURIComponent(loaderData.next)}`;

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-6 py-10 lg:px-10">
      <div className="flex items-center justify-between rounded-full border border-stone-800/80 bg-stone-950/60 px-5 py-3 backdrop-blur">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-300">
            TMAGen
          </p>
          <p className="mt-1 text-xs text-stone-400">
            Authentication and profile bootstrap
          </p>
        </div>
        <Link
          to="/"
          className="rounded-full border border-stone-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-200 transition hover:border-stone-500"
        >
          Back Home
        </Link>
      </div>

      <section className="mt-10 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <aside className="rounded-[2rem] border border-stone-800/80 bg-stone-950/80 p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
            Why auth exists already
          </p>
          <h1 className="mt-4 font-display text-4xl text-stone-50">
            Story ownership, revision history, and archive permissions all start here.
          </h1>
          <p className="mt-5 text-sm leading-7 text-stone-300">
            This first pass keeps authentication intentionally narrow: email/password sign-in,
            automatic profile creation in Supabase, and a protected workspace route to prove the
            stack is connected end to end.
          </p>
          <div className="mt-8 space-y-3">
            {[
              "Supabase auth session cookie is written on the server.",
              "The profile row is created by the database trigger in the initial migration.",
              "Protected routes now have a real user identity to work with.",
            ].map((item) => (
              <div
                key={item}
                className="rounded-2xl border border-stone-800 bg-stone-900/75 px-4 py-3 text-sm text-stone-200"
              >
                {item}
              </div>
            ))}
          </div>
        </aside>

        <div className="space-y-6">
          {errorMessage ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {errorMessage}
            </div>
          ) : null}
          {actionData?.success ? (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
              {actionData.success}
            </div>
          ) : null}

          <section className="rounded-[2rem] border border-stone-800/80 bg-stone-950/80 p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
              Sign in
            </p>
            <Form method="post" action={formAction} className="mt-5 space-y-4">
              <input type="hidden" name="intent" value="sign-in" />
              <input type="hidden" name="next" value={loaderData.next} />
              <label className="block space-y-2">
                <span className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-400">
                  Email
                </span>
                <input
                  required
                  name="email"
                  type="email"
                  defaultValue={actionData?.fields?.email ?? ""}
                  className="w-full rounded-2xl border border-stone-700 bg-stone-900/80 px-4 py-3 text-sm text-stone-100 outline-none transition focus:border-amber-400"
                />
              </label>
              <label className="block space-y-2">
                <span className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-400">
                  Password
                </span>
                <input
                  required
                  name="password"
                  type="password"
                  className="w-full rounded-2xl border border-stone-700 bg-stone-900/80 px-4 py-3 text-sm text-stone-100 outline-none transition focus:border-amber-400"
                />
              </label>
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-full border border-amber-400/40 bg-amber-500/15 px-5 py-3 text-sm font-semibold uppercase tracking-[0.22em] text-amber-100 transition hover:border-amber-300/60 hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting && actionData?.intent === "sign-in" ? "Signing In..." : "Sign In"}
              </button>
            </Form>
          </section>

          <section className="rounded-[2rem] border border-stone-800/80 bg-stone-950/80 p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
              Create account
            </p>
            <Form method="post" action={formAction} className="mt-5 space-y-4">
              <input type="hidden" name="intent" value="sign-up" />
              <input type="hidden" name="next" value={loaderData.next} />
              <label className="block space-y-2">
                <span className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-400">
                  Display name
                </span>
                <input
                  required
                  name="displayName"
                  type="text"
                  defaultValue={actionData?.fields?.displayName ?? ""}
                  className="w-full rounded-2xl border border-stone-700 bg-stone-900/80 px-4 py-3 text-sm text-stone-100 outline-none transition focus:border-amber-400"
                />
              </label>
              <label className="block space-y-2">
                <span className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-400">
                  Email
                </span>
                <input
                  required
                  name="email"
                  type="email"
                  defaultValue={actionData?.fields?.email ?? ""}
                  className="w-full rounded-2xl border border-stone-700 bg-stone-900/80 px-4 py-3 text-sm text-stone-100 outline-none transition focus:border-amber-400"
                />
              </label>
              <label className="block space-y-2">
                <span className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-400">
                  Password
                </span>
                <input
                  required
                  name="password"
                  type="password"
                  className="w-full rounded-2xl border border-stone-700 bg-stone-900/80 px-4 py-3 text-sm text-stone-100 outline-none transition focus:border-amber-400"
                />
              </label>
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-full border border-stone-700 bg-stone-900/80 px-5 py-3 text-sm font-semibold uppercase tracking-[0.22em] text-stone-100 transition hover:border-stone-500 hover:bg-stone-900 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting && actionData?.intent === "sign-up"
                  ? "Creating Account..."
                  : "Create Account"}
              </button>
            </Form>
          </section>
        </div>
      </section>
    </main>
  );
}

function normalizeQueryMessage(value: string | null) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
