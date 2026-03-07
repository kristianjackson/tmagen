import { redirect } from "react-router";

import type { Route } from "./+types/auth-callback";
import {
  buildAuthErrorRedirect,
  getSafeNextPath,
} from "../lib/auth-redirect";
import type { AppEnv } from "../lib/env.server";
import { createSupabaseServerClient } from "../lib/supabase/server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as AppEnv;
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient({
    env,
    request,
    responseHeaders,
  });
  const url = new URL(request.url);
  const next = getSafeNextPath(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  const authError = url.searchParams.get("error");
  const authErrorDescription = url.searchParams.get("error_description");

  if (authError) {
    return redirect(buildAuthErrorRedirect(next, authErrorDescription ?? authError), {
      headers: responseHeaders,
    });
  }

  if (!code) {
    return redirect(buildAuthErrorRedirect(next, "Email confirmation link is missing a code."), {
      headers: responseHeaders,
    });
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return redirect(buildAuthErrorRedirect(next, error.message), {
      headers: responseHeaders,
    });
  }

  return redirect(next, { headers: responseHeaders });
}

export default function AuthCallback() {
  return null;
}
