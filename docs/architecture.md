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

The first repository script only does steps 1 to 3. That keeps the first pass deterministic and cheap.

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

The eventual generation path should be:

1. User chooses canon mode, cast policy, fears, and optional prompt seed
2. System builds a structured brief
3. Relevant transcript chunks are retrieved via hybrid search
4. Model produces an outline
5. Model produces a draft from the outline plus retrieved material
6. Revisions create new story versions with their own provenance snapshot

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

1. Finish local transcript extraction output and review a handful of cleaned files
2. Apply the initial Supabase schema
3. Add Supabase client wiring to the web app
4. Build auth, creator workspace, and story archive tables into the UI
5. Add metadata generation and embedding jobs
