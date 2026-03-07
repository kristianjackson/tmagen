import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("auth", "routes/auth.tsx"),
  route("auth/callback", "routes/auth-callback.tsx"),
  route("auth/confirm", "routes/auth-confirm.tsx"),
  route("workspace", "routes/workspace.tsx"),
  route("account", "routes/account.tsx"),
  route("logout", "routes/logout.tsx"),
] satisfies RouteConfig;
