# TMAGen

TMAGen is an unofficial fan-made story lab inspired by *The Magnus Archives*.

It is built around one simple idea: if you are going to generate Magnus-adjacent fiction at all, the source material should stay visible. TMAGen grounds drafts in transcript retrieval, preserves revision history, keeps provenance attached to story versions, and publishes exact chosen versions instead of disposable output.

Live site: `https://tmagen-web.kristian-jackson.workers.dev/`

## What It Does

TMAGen combines a corpus pipeline, a creator workspace, and a public archive:

- imports and structures the transcript corpus
- generates episode metadata and chunk embeddings
- retrieves relevant source material for a story brief
- generates statement-format horror drafts
- supports revision without overwriting prior versions
- publishes exact versions to public story routes
- keeps source provenance visible instead of hiding the archive behind a black box

## Why It Is Interesting

Most “AI writing” demos stop at prompt -> text.

TMAGen is more opinionated than that:

- retrieval-first: stories are grounded in archive material before generation
- version-first: drafts are immutable artifacts, not mutable blobs
- audit-friendly: prompt snapshots, retrieval packets, and provenance survive revision
- archive-aware: public stories are separate from creator tooling
- statement-driven: stories now default to a format recognizably adjacent to Magnus statements instead of generic prose

## Current Public Showcase

Current archive feed:

- `https://tmagen-web.kristian-jackson.workers.dev/`

Current published stories:

- `Platform Nine, No Service`
- `The Last Floor Plan`
- `The Last Weather Balloon`
- `No Tape Attached`
- `Room Tone`

## Current Product Surfaces

- `/`: public landing page plus published archive feed
- `/auth`: sign-up and sign-in
- `/workspace`: private creator workspace for briefs, generation, revision, publishing, and provenance inspection
- `/stories/:storySlug`: canonical public story route
- `/stories/:storySlug/v/:versionNumber`: version-specific public story route
- `/account`: internal transcript dashboard for corpus review and retrieval inspection

## Stack

- Cloudflare Workers
- React Router
- Supabase
- OpenAI API

## Current Pipeline

1. Extract transcript PDFs into structured JSON.
2. Import episodes and chunks into Supabase.
3. Generate episode metadata.
4. Generate chunk embeddings.
5. Retrieve source material for a brief.
6. Generate a statement-format draft.
7. Revise into child versions.
8. Publish an exact version to the public archive.

## Local Workflow

Run these from the repository root:

```bash
npm run dev
npm run typecheck
npm run build
npm run extract:transcripts
npm run import:transcripts
npm run generate:metadata
npm run generate:embeddings
npm run evaluate:retrieval
npm run smoke:web -- --base-url https://tmagen-web.kristian-jackson.workers.dev
```

Showcase helpers:

```bash
npm run create:showcase
npm run reformat:showcase
npm run capture:showcase
```

## Repository Layout

- `apps/web`: Cloudflare Workers + React Router app
- `supabase`: schema, migrations, and database config
- `scripts`: ingestion, generation, evaluation, smoke, and showcase tooling
- `docs`: setup, architecture, roadmap, release, and outreach notes
- `data/processed/episodes`: generated transcript JSON artifacts, kept out of git
- `tma_source_transcripts`: local source PDFs, kept out of git

## Start Here

1. Read [docs/setup.md](./docs/setup.md).
2. Read [docs/architecture.md](./docs/architecture.md).
3. Check [docs/roadmap.md](./docs/roadmap.md) for current priorities.

Useful project docs:

- [docs/release-checklist.md](./docs/release-checklist.md)
- [docs/outreach-readiness.md](./docs/outreach-readiness.md)
- [docs/outreach-email.md](./docs/outreach-email.md)

## Current State

TMAGen already has:

- transcript import
- episode metadata generation
- chunk embeddings
- hybrid retrieval
- creator workspace
- revision flow
- publish/unpublish flow
- public archive feed
- retrieval benchmarks
- deployed smoke coverage

The main work left is quality and polish, not missing infrastructure.

## Important Note

TMAGen is unofficial and fan-made. *The Magnus Archives* and its source material belong to Rusty Quill.
