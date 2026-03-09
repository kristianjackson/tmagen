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
- draft deletion and project deletion
- provenance links from generated drafts back to source episodes

The main gap is no longer infrastructure. The main gap is product loop depth: publishing, public reading surfaces, and quality control.

## Recently Completed

### Revision Workflow

Completed outcomes:

- `Revise draft` action in the active draft view
- immutable child versions via `parent_version_id`
- revision instructions stored on the child version
- applied revision feedback stored in `story_feedback`
- live workspace lineage, revision brief display, and preserved provenance links

## Active Plan

### 1. Publishing And Reader Surfaces

Turn private drafts into publishable stories and expose a proper reading experience.

Target outcomes:

- add a dedicated reader route for a single story version
- add publish and unpublish controls
- create stable public story URLs
- build the public archive feed from published versions only
- separate creator editing views from reader-facing presentation

Why this is first:

- revision needs a destination
- the current workspace is a creation surface, not a reader surface
- the public archive is part of the original product promise

Implementation notes:

- publish explicit versions, not mutable projects
- keep unpublished versions private by default
- store published timestamps on the version actually exposed to readers
- avoid leaking transcript-only or internal provenance data into the public UI

### 2. Evaluation, Testing, And Retrieval Hardening

Add operational discipline around retrieval quality and story generation quality.

Target outcomes:

- define a small set of canonical story briefs for evaluation
- add smoke tests for auth, workspace, generation, deletion, and publishing
- validate retrieval quality against expected source material
- improve provenance display from episode-level links to clearer chunk-level evidence
- tighten failure handling around model output quality and retry policy

Why this is second:

- the system now works, but quality will drift unless measured
- retrieval-first systems are only trustworthy if the seams are testable
- this reduces regressions as the creator workflow gets more complex

Implementation notes:

- test the boundaries: auth cookies, RLS, version creation, and destructive actions
- keep a human-reviewed benchmark set for retrieval quality
- prefer structured generation metadata over ad hoc logs
- surface model usage and retrieval packet size in the UI for easier debugging

### 3. Richer Editorial Controls And Provenance

Deepen the creator loop now that revision exists.

Target outcomes:

- add regeneration controls that let the creator choose whether retrieval should be refreshed
- improve provenance display from episode-level links to chunk-level evidence where useful
- add richer editorial transforms such as title rewrites, tone shifts, and canon checks
- make version-to-version comparison easier in the workspace

Why this is third:

- the basic revision loop works, but it is still coarse
- provenance can be more transparent than a flat episode list
- editorial tools matter more once publishable versions exist

Implementation notes:

- keep retrieval refresh explicit rather than implicit
- never lose the original retrieval snapshot when creating derived versions
- prefer additive editorial tools over mutable in-place editing
- keep provenance readable enough for creators without exposing internal-only detail in public views

## Later Backlog

After the active plan, likely follow-on work is:

- admin or operator roles for the transcript dashboard
- custom domain and production smoke monitoring

## Working Principle

TMAGen should stay version-first, retrieval-first, and audit-friendly:

- version-first: generated stories are immutable artifacts
- retrieval-first: drafts stay grounded in source material instead of hidden fine-tuning
- audit-friendly: prompts, retrieval packets, and provenance remain inspectable
