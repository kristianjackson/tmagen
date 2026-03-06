import { createServerClient } from "@supabase/ssr";
import { createCookie } from "react-router";

import { getPublicEnv, type AppEnv } from "../env.server";

type CookieRecord = {
  name: string;
  value: string;
};

type ServerClientArgs = {
  env: AppEnv;
  request: Request;
  responseHeaders: Headers;
};

export function createSupabaseServerClient({
  env,
  request,
  responseHeaders,
}: ServerClientArgs) {
  const { supabaseAnonKey, supabaseUrl } = getPublicEnv(env);
  const requestCookies = parseCookieHeader(request.headers.get("cookie"));

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
    cookies: {
      getAll() {
        return requestCookies;
      },
      async setAll(cookiesToSet) {
        for (const cookieToSet of cookiesToSet) {
          const index = requestCookies.findIndex(
            (cookie) => cookie.name === cookieToSet.name,
          );

          if (index === -1) {
            requestCookies.push({
              name: cookieToSet.name,
              value: cookieToSet.value,
            });
          } else {
            requestCookies[index] = {
              name: cookieToSet.name,
              value: cookieToSet.value,
            };
          }

          const cookie = createCookie(cookieToSet.name, cookieToSet.options);
          responseHeaders.append(
            "Set-Cookie",
            await cookie.serialize(cookieToSet.value),
          );
        }
      },
    },
    global: {
      headers: {
        "X-Client-Info": "tmagen/web-server",
      },
    },
  });
}

function parseCookieHeader(header: string | null): CookieRecord[] {
  if (!header) {
    return [];
  }

  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      const name = separatorIndex === -1 ? part : part.slice(0, separatorIndex);
      const rawValue = separatorIndex === -1 ? "" : part.slice(separatorIndex + 1);

      return {
        name,
        value: safeDecodeCookieValue(rawValue),
      };
    });
}

function safeDecodeCookieValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
