export type PublicEnv = {
  appName: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
};

declare global {
  interface Window {
    __TMAGEN_ENV__?: PublicEnv;
  }
}

export function serializePublicEnvScript(publicEnv: PublicEnv) {
  return `window.__TMAGEN_ENV__ = ${JSON.stringify(publicEnv)};`;
}

export function getPublicEnvFromWindow() {
  if (typeof window === "undefined" || !window.__TMAGEN_ENV__) {
    throw new Error("TMAGen public environment is not available in the browser runtime.");
  }

  return window.__TMAGEN_ENV__;
}
