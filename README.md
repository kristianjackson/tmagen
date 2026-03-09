# TMAGen

TMAGen is a Cloudflare-hosted, Supabase-backed fan-fiction platform inspired by *The Magnus Archives*. The project is structured so the public browsing experience, creator workspace, transcript ingestion pipeline, and generated-story archive can evolve in the same repository without turning into a pile of unrelated scripts.

## Current Baseline

- `apps/web` contains the Cloudflare Workers + React Router web app.
- `supabase` contains the Supabase CLI config and the first schema migration.
- `scripts/extract-transcripts.mjs` converts the local transcript PDFs into cleaned JSON files that are ready for metadata generation and embedding.
- `scripts/generate-episode-metadata.mjs` fills episode summaries, hooks, fear tags, and retrieval metadata after transcript import.
- `scripts/generate-chunk-embeddings.mjs` backfills `episode_chunks.embedding` and seeds chunk fear tags for retrieval.
- `scripts/smoke-web-flow.mjs` runs the end-to-end auth, workspace, revision, publish, and cleanup smoke flow against a deployed app.
- `scripts/evaluate-retrieval.mjs` runs the curated retrieval benchmark set against the live corpus.
- `docs/setup.md` contains the detailed manual steps for local setup, Supabase setup, Cloudflare setup, and MCP wiring.
- `docs/roadmap.md` is the active implementation plan and priority reference.
- `docs/release-checklist.md` is the deploy-time verification checklist.
- `docs/outreach-readiness.md` is the public-facing polish and outreach prep checklist.

## Current App Surfaces

- `/`: public landing page plus published archive feed
- `/auth`: sign-up and sign-in
- `/workspace`: private creator workspace for story briefs, draft generation, revisions, publishing, and retrieval provenance
- `/stories/:storySlug`: canonical public story reader route
- `/stories/:storySlug/v/:versionNumber`: version-specific public story reader route
- `/account`: internal transcript dashboard for corpus review and provenance inspection

## Repository Layout

- `apps/web`: web application deployed to Cloudflare Workers
- `data/processed/episodes`: generated transcript JSON output, ignored from git
- `docs`: architecture notes and setup instructions
- `scripts`: local tooling for transcript extraction and future ingestion jobs
- `supabase`: database configuration, migrations, and seed files
- `tma_source_transcripts`: local source PDFs, intentionally ignored from git

## Commands

Run these from the repository root:

```bash
npm run dev
npm run typecheck
npm run build
npm run extract:transcripts
npm run generate:metadata -- --dry-run
npm run generate:metadata
npm run generate:embeddings -- --dry-run
npm run generate:embeddings
npm run evaluate:retrieval
npm run create:showcase
npm run smoke:web -- --base-url https://tmagen-web.kristian-jackson.workers.dev
```

## Recommended Order

1. Read [docs/setup.md](./docs/setup.md).
2. Run `npm run dev` and confirm the web app boots.
3. Run `npm run extract:transcripts` to create the first cleaned transcript artifacts.
4. Create the Supabase project and apply the first migration.
5. Run `npm run import:transcripts`, then `npm run generate:metadata`.
6. Run `npm run generate:embeddings`.
7. Configure Cloudflare secrets and deploy the web app.

## Notes

- The local transcript corpus is deliberately kept out of git.
- The first web app screen is a project-specific landing/status page, not the final product UI.
- The first schema is intentionally conservative: it covers transcript storage, generated story versioning, and public/private visibility without pretending the whole product is already finished.
