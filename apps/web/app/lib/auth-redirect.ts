export function getSafeNextPath(value: FormDataEntryValue | string | null) {
  if (typeof value !== "string" || value.length === 0) {
    return "/workspace";
  }

  if (!value.startsWith("/") || value.startsWith("//")) {
    return "/workspace";
  }

  return value;
}

export function buildAuthConfirmUrl(request: Request, next: string) {
  const confirmUrl = new URL("/auth/confirm", request.url);
  confirmUrl.searchParams.set("next", getSafeNextPath(next));
  return confirmUrl.toString();
}

export function buildAuthErrorRedirect(next: string, error: string) {
  const redirectUrl = new URL("/auth", "http://tmagen.local");
  redirectUrl.searchParams.set("next", getSafeNextPath(next));
  redirectUrl.searchParams.set("error", error);
  return `${redirectUrl.pathname}${redirectUrl.search}`;
}
