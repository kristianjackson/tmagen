import { createClient } from "@supabase/supabase-js";

import { requireEnvBinding, type AppEnv } from "../env.server";

export function createSupabaseAdminClient(env: AppEnv) {
  return createClient(
    requireEnvBinding(env, "SUPABASE_URL"),
    requireEnvBinding(env, "SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          "X-Client-Info": "tmagen/web-admin",
        },
      },
    },
  );
}
