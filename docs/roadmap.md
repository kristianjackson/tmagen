# Roadmap

This file is the active planning reference for TMAGen. When priorities shift, update this document rather than letting the plan drift across chat history.

## Current State

The current system has these foundations in place:

- transcript extraction and import
- episode-level metadata generation
- chunk embeddings and hybrid retrieval
- working auth and creator workspace
- first-pass draft generation with prompt and retrieval snapshots
- draft deletion and project deletion
- provenance links from generated drafts back to source episodes

The main gap is no longer infrastructure. The main gap is product loop depth: revision, publishing, and quality control.

## Active Plan

### 1. Revision Workflow

Build revision-aware generation on top of immutable `story_versions`.

Target outcomes:

- add a `Revise draft` action to the active draft view
- accept free-form revision instructions from the creator
- generate a new child version with `parent_version_id`
- store revision instructions alongside the new version
- make version-to-version comparison possible in the workspace

Why this is first:

- one-shot generation is not enough for real writing
- the schema already supports immutable version chains
- this unlocks meaningful creator iteration without sacrificing auditability

Implementation notes:

- never overwrite draft content in place
- always create a new `story_versions` row
- capture prompt snapshot, retrieval snapshot, and revision instructions on every new version
- preserve provenance even when retrieval is refreshed for a revision pass

### 2. Publishing And Reader Surfaces

Turn private drafts into publishable stories and expose a proper reading experience.

Target outcomes:

- add a dedicated reader route for a single story version
- add publish and unpublish controls
- create stable public story URLs
- build the public archive feed from published versions only
- separate creator editing views from reader-facing presentation

Why this is second:

- revision needs a destination
- the current workspace is a creation surface, not a reader surface
- the public archive is part of the original product promise

Implementation notes:

- publish explicit versions, not mutable projects
- keep unpublished versions private by default
- store published timestamps on the version actually exposed to readers
- avoid leaking transcript-only or internal provenance data into the public UI

### 3. Evaluation, Testing, And Retrieval Hardening

Add operational discipline around retrieval quality and story generation quality.

Target outcomes:

- define a small set of canonical story briefs for evaluation
- add smoke tests for auth, workspace, generation, deletion, and publishing
- validate retrieval quality against expected source material
- improve provenance display from episode-level links to clearer chunk-level evidence
- tighten failure handling around model output quality and retry policy

Why this is third:

- the system now works, but quality will drift unless measured
- retrieval-first systems are only trustworthy if the seams are testable
- this reduces regressions as the creator workflow gets more complex

Implementation notes:

- test the boundaries: auth cookies, RLS, version creation, and destructive actions
- keep a human-reviewed benchmark set for retrieval quality
- prefer structured generation metadata over ad hoc logs
- surface model usage and retrieval packet size in the UI for easier debugging

## Later Backlog

After the active plan, likely follow-on work is:

- chunk-level provenance display inside stories
- regeneration controls that let the user choose whether retrieval should be refreshed
- richer editorial tools such as title rewrites, tone shifts, and canon checks
- admin or operator roles for the transcript dashboard
- custom domain and production smoke monitoring

## Working Principle

TMAGen should stay version-first, retrieval-first, and audit-friendly:

- version-first: generated stories are immutable artifacts
- retrieval-first: drafts stay grounded in source material instead of hidden fine-tuning
- audit-friendly: prompts, retrieval packets, and provenance remain inspectable
