export function getSafeNextPath(value: FormDataEntryValue | string | null) {
  if (typeof value !== "string" || value.length === 0) {
    return "/account";
  }

  if (!value.startsWith("/") || value.startsWith("//")) {
    return "/account";
  }

  return value;
}

export function buildAuthCallbackUrl(request: Request, next: string) {
  const callbackUrl = new URL("/auth/callback", request.url);
  callbackUrl.searchParams.set("next", getSafeNextPath(next));
  return callbackUrl.toString();
}

export function buildAuthErrorRedirect(next: string, error: string) {
  const redirectUrl = new URL("/auth", "http://tmagen.local");
  redirectUrl.searchParams.set("next", getSafeNextPath(next));
  redirectUrl.searchParams.set("error", error);
  return `${redirectUrl.pathname}${redirectUrl.search}`;
}
