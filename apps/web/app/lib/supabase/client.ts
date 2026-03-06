import { createBrowserClient } from "@supabase/ssr";

import { getPublicEnvFromWindow } from "../public-env";

let browserClient: ReturnType<typeof createBrowserClient> | undefined;

export function getSupabaseBrowserClient() {
  if (!browserClient) {
    const publicEnv = getPublicEnvFromWindow();

    browserClient = createBrowserClient(
      publicEnv.supabaseUrl,
      publicEnv.supabaseAnonKey,
      {
        auth: {
          flowType: "pkce",
        },
        global: {
          headers: {
            "X-Client-Info": "tmagen/web-browser",
          },
        },
      },
    );
  }

  return browserClient;
}
