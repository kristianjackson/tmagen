import type { PublicEnv } from "./public-env";

export type AppEnv = Env & {
  APP_NAME?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  OPENAI_CHAT_MODEL?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  SESSION_SECRET?: string;
};

export function getPublicEnv(env: AppEnv): PublicEnv {
  return {
    appName: env.APP_NAME ?? "TMAGen",
    supabaseUrl: requireBinding(env, "SUPABASE_URL"),
    supabaseAnonKey: requireBinding(env, "SUPABASE_ANON_KEY"),
  };
}

function requireBinding<T extends keyof AppEnv>(env: AppEnv, key: T) {
  const value = env[key];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required environment binding: ${String(key)}`);
  }

  return value;
}
