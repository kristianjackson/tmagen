import type { Route } from "./+types/auth-confirm";
import type { AppEnv } from "../lib/env.server";
import { handleAuthConfirmation } from "../lib/auth-confirm.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  return handleAuthConfirmation({
    env: context.cloudflare.env as AppEnv,
    request,
  });
}

export default function AuthConfirm() {
  return null;
}
