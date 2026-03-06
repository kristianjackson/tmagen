import type { User } from "@supabase/supabase-js";

import type { AppEnv } from "./env.server";
import { createSupabaseServerClient } from "./supabase/server";

export type Viewer = {
  user: {
    id: string;
    email: string | null;
    displayName: string;
  };
  profile: {
    id: string;
    handle: string | null;
    displayName: string;
    bio: string | null;
  } | null;
};

type ViewerArgs = {
  env: AppEnv;
  request: Request;
};

export async function getViewer({ env, request }: ViewerArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient({
    env,
    request,
    responseHeaders,
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  let profile: Viewer["profile"] = null;

  if (user) {
    const { data } = await supabase
      .from("profiles")
      .select("id, handle, display_name, bio")
      .eq("id", user.id)
      .maybeSingle();

    if (data) {
      profile = {
        id: data.id,
        handle: data.handle,
        displayName: data.display_name,
        bio: data.bio,
      };
    }
  }

  return {
    responseHeaders,
    supabase,
    viewer: user
      ? {
          user: {
            id: user.id,
            email: user.email ?? null,
            displayName: getUserDisplayName(user),
          },
          profile,
        }
      : null,
  };
}

function getUserDisplayName(user: User) {
  const metadataName = user.user_metadata?.display_name;

  if (typeof metadataName === "string" && metadataName.trim().length > 0) {
    return metadataName.trim();
  }

  if (user.email) {
    return user.email.split("@")[0];
  }

  return "Archivist";
}
