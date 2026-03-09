# Roadmap

This file is the active planning reference for TMAGen. When priorities shift, update this document rather than letting the plan drift across chat history.

## Current State

The current system has these foundations in place:

- transcript extraction and import
- episode-level metadata generation
- chunk embeddings and hybrid retrieval
- working auth and creator workspace
- first-pass draft generation with prompt and retrieval snapshots
- revision-aware child versions with stored revision notes and feedback
- published story routes and archive feed driven by explicit version publication
- draft deletion and project deletion
- provenance links from generated drafts back to source episodes

The main gap is no longer infrastructure. The main gap is product loop discipline: quality control, richer editorial tooling, and production polish.

## Recently Completed

### Revision Workflow

Completed outcomes:

- `Revise draft` action in the active draft view
- immutable child versions via `parent_version_id`
- revision instructions stored on the child version
- applied revision feedback stored in `story_feedback`
- live workspace lineage, revision brief display, and preserved provenance links

### Publishing And Reader Surfaces

Completed outcomes:

- dedicated public story routes for canonical and version-specific reading
- publish and unpublish controls in the workspace
- public archive feed populated from published versions only
- stable reader URLs with canonical version switching
- live smoke-tested publish and unpublish flow against the deployed Worker

## Active Plan

### 1. Evaluation, Testing, And Retrieval Hardening

Add operational discipline around retrieval quality and story generation quality.

Target outcomes:

- define a small set of canonical story briefs for evaluation
- add smoke tests for auth, workspace, generation, revision, deletion, and publishing
- validate retrieval quality against expected source material
- improve provenance display from episode-level links to clearer chunk-level evidence
- tighten failure handling around model output quality and retry policy

Why this is second:

- the system now works across the full loop, but quality will drift unless measured
- retrieval-first systems are only trustworthy if the seams are testable
- this reduces regressions as the creator workflow gets more complex

Implementation notes:

- test the boundaries: auth cookies, RLS, version creation, and destructive actions
- keep a human-reviewed benchmark set for retrieval quality and published-story quality
- prefer structured generation metadata over ad hoc logs
- surface model usage and retrieval packet size in the UI for easier debugging

### 2. Richer Editorial Controls And Provenance

Deepen the creator loop now that revision exists.

Target outcomes:

- add regeneration controls that let the creator choose whether retrieval should be refreshed
- improve provenance display from episode-level links to chunk-level evidence where useful
- add richer editorial transforms such as title rewrites, tone shifts, and canon checks
- make version-to-version comparison easier in the workspace

Why this is third:

- the basic revision and publishing loops work, but they are still coarse
- provenance can be more transparent than a flat episode list
- editorial tools matter more once publishable versions exist

Implementation notes:

- keep retrieval refresh explicit rather than implicit
- never lose the original retrieval snapshot when creating derived versions
- prefer additive editorial tools over mutable in-place editing
- keep provenance readable enough for creators without exposing internal-only detail in public views

### 3. Production Polish And Rollout Discipline

Bring the now-working product loop closer to a dependable public deployment.

Target outcomes:

- connect a custom domain for the public archive
- add lightweight production monitoring and route health checks
- define a manual release checklist for auth, workspace, publish, and public reading flows
- tighten role boundaries for the transcript dashboard and other internal surfaces

Why this is third:

- the product loop is now visible to readers, so reliability matters more
- a custom domain and smoke monitoring are higher leverage now that publishing exists
- internal/operator surfaces should not stay loosely protected forever

Implementation notes:

- keep the release checklist small enough to run before every deploy
- verify both anonymous and authenticated flows against production
- separate reader-safe telemetry from internal debugging data
- prefer explicit admin/operator controls over broad authenticated access

## Later Backlog

After the active plan, likely follow-on work is:

- admin or operator roles for the transcript dashboard
- custom domain and production smoke monitoring

## Working Principle

TMAGen should stay version-first, retrieval-first, and audit-friendly:

- version-first: generated stories are immutable artifacts
- retrieval-first: drafts stay grounded in source material instead of hidden fine-tuning
- audit-friendly: prompts, retrieval packets, and provenance remain inspectable
