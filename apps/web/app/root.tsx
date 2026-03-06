import {
  data,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { getPublicEnv, type AppEnv } from "./lib/env.server";
import { serializePublicEnvScript } from "./lib/public-env";
import { getViewer } from "./lib/viewer.server";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Literata:opsz,wght@7..72,400;7..72,500;7..72,700&family=Manrope:wght@400;500;600;700;800&display=swap",
  },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as AppEnv;
  const { responseHeaders, viewer } = await getViewer({ env, request });

  return data(
    {
      publicEnv: getPublicEnv(env),
      viewer,
    },
    { headers: responseHeaders },
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="font-sans antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <script
        suppressHydrationWarning
        dangerouslySetInnerHTML={{
          __html: serializePublicEnvScript(loaderData.publicEnv),
        }}
      />
      <Outlet />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16 text-stone-100">
      <div className="rounded-3xl border border-stone-800 bg-stone-950/90 p-8 shadow-2xl shadow-black/30">
        <p className="text-xs font-semibold uppercase tracking-[0.32em] text-amber-300">
          TMAGen
        </p>
        <h1 className="mt-4 font-display text-4xl text-stone-50">{message}</h1>
        <p className="mt-4 text-sm leading-7 text-stone-300">{details}</p>
      </div>
      {stack && (
        <pre className="mt-6 w-full overflow-x-auto rounded-2xl border border-stone-800 bg-stone-950/70 p-4 text-sm text-stone-200">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
