# Architecture

## Platform Choices

- Hosting: Cloudflare Workers
- Web framework: React Router v7
- Database, auth, storage, and vector search: Supabase
- LLM provider: OpenAI for generation and embeddings
- MCP targets: Cloudflare managed MCP servers and Supabase MCP server

This stack keeps the deployment target native to Cloudflare while leaving the data model and AI workflow in Postgres, where auditability and versioning are easier to reason about.

## Product Surfaces

The product should be treated as three surfaces inside one system:

1. Public archive feed for anonymous browsing
2. Authenticated creator workspace for prompts, editing, and regeneration
3. Internal transcript dashboard for ingestion review and provenance tracking

The public feed is read-heavy and should only expose stories that have been explicitly published by the creator. The creator workspace needs immutable version history. The transcript dashboard is an operator tool and should stay behind server-side access until we decide how to manage admin roles.

## Transcript Pipeline

The transcript corpus is already text-based PDF, so the ingestion path is:

1. Extract PDF text deterministically with `pdftotext`
2. Clean headers, page numbers, and formatting noise
3. Save a cleaned JSON record per episode
4. Generate structured metadata with the LLM
5. Chunk the transcript for search and embeddings
6. Store chunk embeddings in Supabase `pgvector`
7. Link generated stories back to the episodes and chunks they used

The current repository scripts cover deterministic extraction/import, episode-level metadata generation,
and chunk embedding backfill. Chunk-level enrichment is currently a seeded first pass from episode-level
fear tags, the internal dashboard includes a hybrid retrieval probe for validation, and the creator
workspace can now turn story briefs into immutable draft versions with prompt and retrieval snapshots,
then create child revisions with stored revision notes and preserved provenance.

## Data Model

The initial schema introduces these core tables:

- `profiles`: public user profile attached to `auth.users`
- `fears`: canonical fear taxonomy for prompt controls and tagging
- `episodes`: one row per transcript, including cleaned text and generated metadata
- `episode_chunks`: chunked transcript records for search and embeddings
- `story_projects`: top-level story concepts and user-selected constraints
- `story_versions`: immutable generated drafts and rewrites
- `story_feedback`: revision notes tied to a story
- `story_episode_links`: provenance links between a draft and the transcript episodes it used

The design is version-first. Generated stories are never overwritten in place.

## Retrieval and Generation Flow

The current generation path is:

1. User chooses canon mode, cast policy, fears, and optional prompt seed
2. System builds a structured brief
3. Relevant transcript chunks are retrieved via hybrid search
4. Model produces a draft from the brief plus retrieved material
5. System stores the draft as a new `story_versions` row
6. System records episode-level provenance links and keeps the retrieval snapshot for auditability
7. User can revise the latest draft into a new child version while keeping the prior version immutable

The next extension is publishing and reader-facing surfaces on top of the revision-aware workspace.

This is deliberately retrieval-first rather than fine-tuning-first. With the current corpus size, that is easier to debug and cheaper to run.

## Access Model

- `episodes` and `episode_chunks` should remain inaccessible to anonymous users
- `story_projects` and `story_versions` should be visible to the owner and public only when `visibility = 'public'`
- `profiles` and `fears` can be publicly readable
- unlisted sharing is intentionally deferred until we add signed share links or tokens

The first migration enables RLS everywhere that matters and keeps transcript tables locked down by default.

## MCP Plan

The intended development assistants are:

- Cloudflare docs MCP server
- Cloudflare bindings MCP server
- Supabase MCP server

Those are useful for schema inspection, migration assistance, and current platform documentation, but they should stay development tools. They are not part of the deployed application.

## Immediate Roadmap

See [docs/roadmap.md](./roadmap.md) for the active implementation plan.
