# TMAGen Web

This is the Cloudflare Workers web application for TMAGen.

## Commands

Run these from `apps/web`:

```bash
npm run dev
npm run typecheck
npm run build
npm run deploy
```

## Environment

Copy `.dev.vars.example` to `.dev.vars` and fill in the real secrets before you start wiring Supabase or OpenAI features into the app.

## Deployment

The worker is configured through `wrangler.jsonc`. The root repository also exposes convenience scripts so you can run `npm run dev` or `npm run deploy:web` from the repo root.
