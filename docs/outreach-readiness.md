# Outreach Readiness

This document is the reference for showing TMAGen to Rusty Quill or other Magnus-adjacent people in a way that is respectful, clear, and easy to evaluate.

## Positioning

TMAGen should be presented as:

- an unofficial fan-made project
- a project built out of love for *The Magnus Archives*
- a demonstration of the archive's creative impact
- a writing and publishing tool that keeps the source material visible

TMAGen should not be presented as:

- a replacement for the original work
- a claim on ownership or endorsement
- a business pitch
- a monetization pitch

## Current Demo Path

The shortest useful walkthrough is:

1. Open `/`
2. Show the public framing, archive feed, and source links
3. Sign in and open `/workspace`
4. Create or open a story brief
5. Generate a draft
6. Revise it once
7. Publish the chosen version
8. Open the public story reader route

The goal is for someone unfamiliar with the project internals to understand the entire loop in under a minute.

## Showcase Automation

Use this command to refresh the current public showcase story and screenshot bundle:

```bash
npm run create:showcase
```

This command:

- creates or refreshes a dedicated showcase account
- creates the showcase project brief
- generates a draft and one revision
- publishes the final version
- captures screenshots into `/tmp/tmagen-showcase`
- writes `/tmp/tmagen-showcase/manifest.json`

To roll the current showcase set forward after a prompt/formatting change:

```bash
npm run reformat:showcase
```

## Current Showcase Set

Current live archive:

- `https://tmagen-web.kristian-jackson.workers.dev/`

Current canonical public stories:

- `https://tmagen-web.kristian-jackson.workers.dev/stories/platform-nine-no-service`
- `https://tmagen-web.kristian-jackson.workers.dev/stories/the-last-floor-plan`
- `https://tmagen-web.kristian-jackson.workers.dev/stories/the-last-weather-balloon`
- `https://tmagen-web.kristian-jackson.workers.dev/stories/no-tape-attached`

Current screenshot bundles:

- `/tmp/tmagen-showcase`
- `/tmp/tmagen-showcase-spiral`
- `/tmp/tmagen-showcase-vast`
- `/tmp/tmagen-showcase-meta`

## Public-Facing Requirements

Before outreach, the live site should keep these visible:

- a clear statement that TMAGen is unofficial and fan-made
- a direct link to Rusty Quill
- a direct link to the official *The Magnus Archives* page
- a direct link to the official transcript archive
- a public story route that works without explanation

## Assets To Prepare

Prepare these before sending any outreach note:

- one live URL
- one repo URL
- three screenshots:
  - landing page
  - workspace with provenance visible
  - published story reader
- one short paragraph explaining why the project exists
- one short paragraph explaining what is technically interesting about it
- one outreach draft that can be pasted without rewriting from scratch

## Technical Readiness Checklist

Before outreach:

- run `npm run typecheck`
- run `npm run build`
- run `npm run evaluate:retrieval`
- run `npm run smoke:web -- --base-url <live-url>`
- verify source and attribution links on the public pages
- verify the demo story route loads while signed out

## Messaging Guidance

The first contact should:

- lead with gratitude
- explain that the project is a fan-made prototype
- explain that the goal is to honor the archive by keeping the source material visible
- invite feedback without asking for endorsement up front

The first contact should not:

- ask for sponsorship
- imply official affiliation
- bury the unofficial status
- rely on prior personal correspondence

## Known Product Gaps

TMAGen is strong enough to show, but it is still improving in these areas:

- retrieval quality still has benchmark misses for some motifs
- provenance display can be made easier to scan
- creator-facing editorial controls can still deepen

These are not blockers for a respectful demo, but they should be understood before outreach.

## Related Documents

- `docs/outreach-email.md`
