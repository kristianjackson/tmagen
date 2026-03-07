import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "react-router";

import {
  buildAuthErrorRedirect,
  getSafeNextPath,
} from "./auth-redirect";
import type { AppEnv } from "./env.server";
import { createSupabaseServerClient } from "./supabase/server";

type HandleAuthConfirmationArgs = {
  env: AppEnv;
  request: Request;
};

const EMAIL_OTP_TYPES = new Set([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

export async function handleAuthConfirmation({
  env,
  request,
}: HandleAuthConfirmationArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient({
    env,
    request,
    responseHeaders,
  });
  const url = new URL(request.url);
  const next = getSafeNextPath(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const otpType = normalizeEmailOtpType(url.searchParams.get("type"));
  const authError = url.searchParams.get("error");
  const authErrorDescription = url.searchParams.get("error_description");

  if (authError) {
    return redirect(buildAuthErrorRedirect(next, authErrorDescription ?? authError), {
      headers: responseHeaders,
    });
  }

  if (tokenHash && otpType) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType,
    });

    if (error) {
      return redirect(buildAuthErrorRedirect(next, error.message), {
        headers: responseHeaders,
      });
    }

    return redirect(next, { headers: responseHeaders });
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      return redirect(buildAuthErrorRedirect(next, error.message), {
        headers: responseHeaders,
      });
    }

    return redirect(next, { headers: responseHeaders });
  }

  return redirect(buildAuthErrorRedirect(next, "Confirmation link is missing required data."), {
    headers: responseHeaders,
  });
}

function normalizeEmailOtpType(value: string | null): EmailOtpType | null {
  if (!value || !EMAIL_OTP_TYPES.has(value)) {
    return null;
  }

  return value as EmailOtpType;
}
