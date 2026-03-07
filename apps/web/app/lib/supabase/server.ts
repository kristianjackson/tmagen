import { createServerClient } from "@supabase/ssr";
import { parse, serialize } from "cookie";

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

          responseHeaders.append("Set-Cookie", serialize(
            cookieToSet.name,
            cookieToSet.value,
            cookieToSet.options,
          ));
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

  return Object.entries(parse(header)).map(([name, value]) => ({
    name,
    value: value ?? "",
  }));
}
