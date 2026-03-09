import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("auth", "routes/auth.tsx"),
  route("auth/callback", "routes/auth-callback.tsx"),
  route("auth/confirm", "routes/auth-confirm.tsx"),
  route("stories/:storySlug", "routes/story-reader.tsx"),
  route("stories/:storySlug/v/:versionNumber", "routes/story-reader.tsx", {
    id: "routes/story-reader-version",
  }),
  route("workspace", "routes/workspace.tsx"),
  route("account", "routes/account.tsx"),
  route("logout", "routes/logout.tsx"),
] satisfies RouteConfig;
