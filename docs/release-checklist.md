# Release Checklist

Use this checklist before and immediately after deploying TMAGen.

## Before Deploy

1. Run `npm run typecheck`.
2. Run `npm run build`.
3. Run `npm run evaluate:retrieval` and review any failing benchmark cases before shipping retrieval-sensitive changes.
4. Confirm any schema-dependent changes are already applied in Supabase.
5. Confirm Cloudflare Worker secrets match the current local env values when required.

## Deploy

1. Run `npm run deploy:web`.
2. Record the deployed Worker version from Wrangler output.
3. Optionally trigger `.github/workflows/smoke-web.yml` from GitHub Actions if you want a hosted post-deploy validation run.

## Post-Deploy Smoke

Run the automated end-to-end smoke flow against the deployed app:

```bash
npm run smoke:web -- --base-url https://tmagen-web.kristian-jackson.workers.dev
```

What this covers:

- temp user creation in Supabase
- sign-in
- workspace load
- project creation
- draft generation
- revision generation
- publish and unpublish
- public archive and story routes
- project deletion
- temp user cleanup

## Manual Spot Checks

1. Open `/` and confirm the public archive feed renders.
2. Open `/auth` and confirm sign-in and sign-up still render correctly.
3. Sign in manually and confirm `/workspace` loads.
4. Confirm `/account` still loads for an authenticated user.
5. If a story is already public, open both `/stories/:storySlug` and `/stories/:storySlug/v/:versionNumber`.

## Rollback Trigger

Rollback or halt further deploys if any of these fail:

- the retrieval benchmark regresses unexpectedly on known benchmark briefs
- auth cookies are not persisted after sign-in
- generation fails for the smoke project
- publish succeeds internally but the public routes do not update
- unpublish leaves public story routes or feed cards visible
- `/account` regresses for authenticated access
