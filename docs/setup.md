# Setup Guide

This guide is written for a junior developer. Follow the steps in order. If one step fails, stop there and fix it before moving on.

## 1. Prerequisites

You need these installed on the machine where you develop:

- Node.js 24 or newer
- npm 11 or newer
- Git
- Docker Desktop or Docker Engine if you want to run Supabase locally
- `pdftotext` from the Poppler tools package

On Ubuntu or Debian, install `pdftotext` like this:

```bash
sudo apt-get update
sudo apt-get install -y poppler-utils
```

Check the basics:

```bash
node -v
npm -v
git --version
pdftotext -v
```

## 2. Start the Web App

From the repository root:

```bash
npm run dev
```

Open the URL shown in the terminal. You should see the TMAGen landing page.

## 3. Extract the Transcript Corpus

Run the first extraction pass:

```bash
npm run extract:transcripts
```

What this does:

- reads every PDF in `./tma_source_transcripts`
- extracts text with `pdftotext`
- removes obvious page headers and page numbers
- writes one JSON file per episode to `./data/processed/episodes`
- writes an `index.json` summary file

If you only want to test a few files first:

```bash
node scripts/extract-transcripts.mjs --input ./tma_source_transcripts --output ./data/processed/episodes --limit 3 --overwrite
```

## 4. Create the Supabase Project

1. Go to the Supabase dashboard and create a new project.
2. Wait for provisioning to finish.
3. In the project dashboard, copy these values:
   - project URL
   - anon key
   - service role key
4. Keep those values safe. The service role key is secret.

### Apply the First Schema

You have two ways to do this.

### Option A: Dashboard SQL Editor

This is the easiest path if you are not ready to use the CLI yet.

1. Open the Supabase SQL Editor.
2. Open the file `supabase/migrations/202603061300_initial_schema.sql` in this repo.
3. Paste the full SQL into the editor.
4. Run it.

### Option B: Supabase CLI

Use this if you want migrations to stay version-controlled and pushable from the terminal.

1. Log in:

```bash
npx supabase@latest login
```

2. Link the repo to your hosted project:

```bash
npx supabase@latest link --project-ref YOUR_PROJECT_REF
```

3. Push the migration:

```bash
npx supabase@latest db push
```

If you want a full local Supabase stack, start it with:

```bash
npx supabase@latest start
```

That requires Docker.

### Configure Supabase Auth URLs

Open Supabase Dashboard -> Authentication -> URL Configuration.

Set:

- Site URL: your active app origin
- Redirect URLs: include the auth confirmation URL for every environment you use

For the current deployed Worker, add:

```text
https://tmagen-web.kristian-jackson.workers.dev/auth/confirm
```

For local development, add the callback URL that matches whatever `npm run dev` prints, for example:

```text
http://localhost:5173/auth/confirm
```

If the Site URL is left on `http://localhost:3000`, Supabase confirmation emails will redirect there.

### Update the Confirm Signup Email Template

Open Supabase Dashboard -> Authentication -> Email Templates -> Confirm signup.

If the template still uses `{{ .ConfirmationURL }}`, PKCE-based SSR flows can fail with errors like
`code challenge does not match previously saved code verifier`.

Use a token-hash confirmation link instead:

```text
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email
```

That route is now implemented in the app and verifies the token server-side.

## 5. Configure Local Secrets for the Web App

Copy the example file:

```bash
cp apps/web/.dev.vars.example apps/web/.dev.vars
```

Then edit `apps/web/.dev.vars` and fill in the real values:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `SESSION_SECRET`

Do not commit `.dev.vars`.

## 6. Import the Cleaned Transcript Corpus into Supabase

First do a dry run. This only reads the cleaned JSON files and shows how many chunks will be written:

```bash
npm run import:transcripts -- --dry-run
```

If that looks correct, run the real import:

```bash
npm run import:transcripts
```

What this does:

- reads every cleaned episode JSON in `./data/processed/episodes`
- chunks transcript text into retrieval-sized records
- upserts `episodes`
- replaces `episode_chunks` for each imported episode
- stores deterministic metadata such as extraction timestamp and transcript checksum

After the import finishes, sign in to the app and open `/workspace` for the creator brief flow.
Use `/account` for the internal transcript dashboard.

## 7. Generate Episode Metadata

Once the transcript corpus is imported, generate the first episode-level metadata pass.

Start with a dry run:

```bash
npm run generate:metadata -- --dry-run
```

Then run the real job:

```bash
npm run generate:metadata
```

Useful filters while you tune prompts:

```bash
npm run generate:metadata -- --episode 32 --force
npm run generate:metadata -- --limit 5
```

What this does:

- reads imported episodes from Supabase using the service-role key in `apps/web/.dev.vars`
- sends each transcript to the configured OpenAI chat model
- writes `summary`, `hook`, `primary_fear_slug`, `secondary_fear_slugs`, and structured `generated_metadata`
- moves successful rows to `import_status = metadata_ready`

If a call fails, that episode is marked `metadata_failed` so you can re-run just the missing records or use `--force`.

## 8. Generate Chunk Embeddings

Once episode metadata is in place, backfill chunk embeddings for vector search and seed chunk fear tags
from the episode taxonomy.

Start with a dry run:

```bash
npm run generate:embeddings -- --dry-run
```

Then run the real job:

```bash
npm run generate:embeddings
```

Useful filters while you tune batch size or recover from an interrupted run:

```bash
npm run generate:embeddings -- --episode 32
npm run generate:embeddings -- --limit 50
npm run generate:embeddings -- --reset --episode 32
```

What this does:

- reads `episode_chunks` from Supabase using the service-role key in `apps/web/.dev.vars`
- requests embeddings from the configured OpenAI embedding model
- writes `episode_chunks.embedding`
- seeds `episode_chunks.fear_slugs` from the episode-level fear assignments
- stores `embedding_model` and `embedding_generated_at` in chunk metadata for auditability

After this finishes, sign in to `/workspace` to create a brief, preview retrieval, and generate the
first draft version, or use `/account` for the lower-level transcript retrieval probe.

## 9. Configure Cloudflare

### Log In

```bash
npx --yes wrangler login
```

### Review the Worker Name

Open `apps/web/wrangler.jsonc` and confirm the worker name is what you want. Right now it is set to `tmagen-web`.

### Add Production Secrets

Run these commands one by one:

```bash
cd apps/web
npx --yes wrangler secret put SUPABASE_URL
npx --yes wrangler secret put SUPABASE_ANON_KEY
npx --yes wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx --yes wrangler secret put OPENAI_API_KEY
npx --yes wrangler secret put SESSION_SECRET
```

When Wrangler prompts you, paste the real value for each secret.

### Deploy

From the repository root:

```bash
npm run deploy:web
```

## 10. MCP Servers

There are two parts here:

- the server URL
- the client configuration format

The server URLs are the stable part:

- Cloudflare docs MCP: `https://docs.mcp.cloudflare.com/mcp`
- Cloudflare bindings MCP: `https://bindings.mcp.cloudflare.com/mcp`
- Supabase MCP: `https://mcp.supabase.com/mcp`

For VS Code, the config file is:

```text
/home/kpjack/.config/Code/User/mcp.json
```

Example:

```json
{
  "servers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp"
    },
    "cloudflare-docs": {
      "type": "http",
      "url": "https://docs.mcp.cloudflare.com/mcp"
    },
    "cloudflare-bindings": {
      "type": "http",
      "url": "https://bindings.mcp.cloudflare.com/mcp"
    }
  }
}
```

For Codex CLI, use:

```bash
codex mcp add supabase --url https://mcp.supabase.com/mcp
codex mcp add cloudflare-docs --url https://docs.mcp.cloudflare.com/mcp
codex mcp add cloudflare-bindings --url https://bindings.mcp.cloudflare.com/mcp
```

If a client prompts for OAuth when you first use a server, complete that in the browser.

## 11. Recommended Next Move After Setup

Once the steps above are complete, the next implementation target should be:

1. publishing and reader routes for finished story versions
2. richer provenance presentation from generated drafts back to chunk retrieval hits
3. broader retrieval-quality validation against real briefs
4. route-level smoke tests and regression checks around auth and workspace flows
