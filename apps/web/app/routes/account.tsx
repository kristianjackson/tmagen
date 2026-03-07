import { data, Form, Link, redirect } from "react-router";

import type { Route } from "./+types/account";
import type { AppEnv } from "../lib/env.server";
import { runChunkRetrievalProbe, type RetrievalProbe } from "../lib/retrieval.server";
import { createSupabaseAdminClient } from "../lib/supabase/admin.server";
import { getViewer } from "../lib/viewer.server";

type EpisodeListItem = {
  id: string;
  episodeNumber: number;
  title: string;
  slug: string;
  importStatus: string;
  wordCount: number | null;
  contentWarnings: string[];
  summary: string | null;
  hook: string | null;
  updatedAt: string;
  storyReferenceCount: number;
  storyProjectCount: number;
  lastUsedAt: string | null;
};

type EpisodeDetail = EpisodeListItem & {
  sourceFilename: string;
  transcriptText: string;
  characterCount: number | null;
  primaryFearSlug: string | null;
  secondaryFearSlugs: string[];
  deterministicMetadata: Record<string, unknown>;
  generatedMetadata: Record<string, unknown>;
};

type EpisodeStoryReference = {
  storyProjectId: string;
  storyTitle: string;
  storySlug: string;
  storyVisibility: string;
  storyVersionId: string;
  versionNumber: number;
  versionVisibility: string;
  relevanceScore: number | null;
  usageReason: string | null;
  linkedAt: string;
};

type FearOption = {
  slug: string;
  name: string;
};

export function meta({}: Route.MetaArgs) {
  return [
    { title: "TMAGen | Transcript Dashboard" },
    {
      name: "description",
      content:
        "Internal TMAGen transcript dashboard for browsing imported episode text, metadata, and story provenance.",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as AppEnv;
  const { responseHeaders, viewer } = await getViewer({ env, request });

  if (!viewer) {
    return redirect("/auth?next=/account", { headers: responseHeaders });
  }

  const adminClient = createSupabaseAdminClient(env);
  const [
    { data: episodeRows, error: episodesError },
    { data: usageRows, error: usageError },
    { data: fearRows, error: fearsError },
    { count: chunkCount, error: chunkCountError },
    { count: embeddedChunkCount, error: embeddedChunkCountError },
  ] = await Promise.all([
    adminClient
      .from("episodes")
      .select(
        "id, episode_number, title, slug, import_status, word_count, content_warnings, summary, hook, updated_at",
      )
      .order("episode_number", { ascending: true }),
    adminClient
      .from("episode_usage_stats")
      .select("episode_id, story_version_count, story_project_count, last_used_at"),
    adminClient.from("fears").select("slug, name").order("sort_order", { ascending: true }),
    adminClient.from("episode_chunks").select("id", { count: "exact", head: true }),
    adminClient
      .from("episode_chunks")
      .select("id", { count: "exact", head: true })
      .not("embedding", "is", null),
  ]);

  if (episodesError) {
    throw data(
      { message: `Failed to load transcript list: ${episodesError.message}` },
      { status: 500, headers: responseHeaders },
    );
  }

  if (usageError) {
    throw data(
      { message: `Failed to load transcript usage: ${usageError.message}` },
      { status: 500, headers: responseHeaders },
    );
  }

  if (fearsError) {
    throw data(
      { message: `Failed to load fear taxonomy: ${fearsError.message}` },
      { status: 500, headers: responseHeaders },
    );
  }

  if (chunkCountError) {
    throw data(
      { message: `Failed to load chunk count: ${chunkCountError.message}` },
      { status: 500, headers: responseHeaders },
    );
  }

  if (embeddedChunkCountError) {
    throw data(
      { message: `Failed to load embedded chunk count: ${embeddedChunkCountError.message}` },
      { status: 500, headers: responseHeaders },
    );
  }

  const usageByEpisode = new Map(
    (usageRows ?? []).map((row) => [
      row.episode_id,
      {
        storyReferenceCount: row.story_version_count ?? 0,
        storyProjectCount: row.story_project_count ?? 0,
        lastUsedAt: row.last_used_at ?? null,
      },
    ]),
  );

  const episodes: EpisodeListItem[] = (episodeRows ?? []).map((row) => {
    const usage = usageByEpisode.get(row.id);

    return {
      id: row.id,
      episodeNumber: row.episode_number,
      title: row.title,
      slug: row.slug,
      importStatus: row.import_status,
      wordCount: row.word_count,
      contentWarnings: row.content_warnings ?? [],
      summary: row.summary,
      hook: row.hook,
      updatedAt: row.updated_at,
      storyReferenceCount: usage?.storyReferenceCount ?? 0,
      storyProjectCount: usage?.storyProjectCount ?? 0,
      lastUsedAt: usage?.lastUsedAt ?? null,
    };
  });

  const url = new URL(request.url);
  const requestedSlug = url.searchParams.get("episode");
  const retrievalQuery = (url.searchParams.get("search") ?? "").trim();
  const requestedFearSlug = (url.searchParams.get("fear") ?? "").trim();
  const selectedEpisodeSummary =
    episodes.find((episode) => episode.slug === requestedSlug) ?? episodes[0] ?? null;
  const selectedEpisodeOnly =
    url.searchParams.get("scope") === "selected" && selectedEpisodeSummary !== null;
  const fearOptions: FearOption[] = (fearRows ?? []).map((row) => ({
    slug: row.slug,
    name: row.name,
  }));
  const selectedFearSlug = fearOptions.some((fear) => fear.slug === requestedFearSlug)
    ? requestedFearSlug
    : null;

  let selectedEpisode: EpisodeDetail | null = null;
  let selectedEpisodeReferences: EpisodeStoryReference[] = [];
  let retrieval: RetrievalProbe | null = null;
  let retrievalError: string | null = null;

  if (selectedEpisodeSummary) {
    const [{ data: episodeDetailRow, error: detailError }, { data: referenceRows, error: referencesError }] =
      await Promise.all([
        adminClient
          .from("episodes")
          .select(
            "id, episode_number, title, slug, source_filename, transcript_text, import_status, word_count, character_count, content_warnings, summary, hook, primary_fear_slug, secondary_fear_slugs, deterministic_metadata, generated_metadata, updated_at",
          )
          .eq("id", selectedEpisodeSummary.id)
          .single(),
        adminClient
          .from("episode_story_references")
          .select(
            "story_project_id, story_title, story_slug, story_visibility, story_version_id, version_number, version_visibility, relevance_score, usage_reason, linked_at",
          )
          .eq("episode_id", selectedEpisodeSummary.id)
          .order("linked_at", { ascending: false }),
      ]);

    if (detailError) {
      throw data(
        { message: `Failed to load episode details: ${detailError.message}` },
        { status: 500, headers: responseHeaders },
      );
    }

    if (referencesError) {
      throw data(
        { message: `Failed to load episode provenance: ${referencesError.message}` },
        { status: 500, headers: responseHeaders },
      );
    }

    selectedEpisode = {
      ...selectedEpisodeSummary,
      sourceFilename: episodeDetailRow.source_filename,
      transcriptText: episodeDetailRow.transcript_text,
      characterCount: episodeDetailRow.character_count,
      primaryFearSlug: episodeDetailRow.primary_fear_slug,
      secondaryFearSlugs: episodeDetailRow.secondary_fear_slugs ?? [],
      deterministicMetadata: asRecord(episodeDetailRow.deterministic_metadata),
      generatedMetadata: asRecord(episodeDetailRow.generated_metadata),
    };

    selectedEpisodeReferences = (referenceRows ?? []).map((row) => ({
      storyProjectId: row.story_project_id,
      storyTitle: row.story_title,
      storySlug: row.story_slug,
      storyVisibility: row.story_visibility,
      storyVersionId: row.story_version_id,
      versionNumber: row.version_number,
      versionVisibility: row.version_visibility,
      relevanceScore: row.relevance_score,
      usageReason: row.usage_reason,
      linkedAt: row.linked_at,
    }));
  }

  if (retrievalQuery.length > 0) {
    try {
      retrieval = await runChunkRetrievalProbe({
        adminClient,
        env,
        query: retrievalQuery,
        episodeId: selectedEpisodeOnly ? selectedEpisodeSummary?.id ?? null : null,
        fearSlug: selectedFearSlug,
      });
    } catch (error) {
      retrievalError = formatError(error);
    }
  }

  return data(
    {
      episodes,
      fearOptions,
      selectedEpisode,
      selectedEpisodeReferences,
      retrieval,
      summary: {
        episodeCount: episodes.length,
        totalWords: episodes.reduce((sum, episode) => sum + (episode.wordCount ?? 0), 0),
        chunkCount: chunkCount ?? 0,
        embeddedChunkCount: embeddedChunkCount ?? 0,
        episodesUsedCount: episodes.filter((episode) => episode.storyReferenceCount > 0).length,
        storyReferenceCount: episodes.reduce(
          (sum, episode) => sum + episode.storyReferenceCount,
          0,
        ),
      },
      view: {
        retrievalError,
        retrievalQuery,
        selectedEpisodeOnly,
        selectedEpisodeSlug: selectedEpisodeSummary?.slug ?? null,
        selectedFearSlug,
      },
      viewer,
    },
    { headers: responseHeaders },
  );
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const {
    episodes,
    fearOptions,
    retrieval,
    selectedEpisode,
    selectedEpisodeReferences,
    summary,
    viewer,
    view,
  } = loaderData;
  const embeddingCoverage =
    summary.chunkCount > 0 ? summary.embeddedChunkCount / summary.chunkCount : 0;

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1440px] px-6 py-10 lg:px-10">
      <div className="flex flex-col gap-4 rounded-[2rem] border border-stone-800/80 bg-stone-950/70 p-6 backdrop-blur lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-300">
            Transcript Dashboard
          </p>
          <h1 className="mt-4 font-display text-4xl text-stone-50">
            Internal archive view for imported Magnus material
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-300">
            Signed in as {viewer.profile?.displayName ?? viewer.user.displayName}. This route uses a
            server-only Supabase client so the transcript corpus and provenance stay out of the public
            surface while we build the real operator role model.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            to="/workspace"
            className="rounded-full border border-stone-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-200 transition hover:border-stone-500"
          >
            Workspace
          </Link>
          <Link
            to="/"
            className="rounded-full border border-stone-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-200 transition hover:border-stone-500"
          >
            Public Feed
          </Link>
          <Form method="post" action="/logout">
            <button
              type="submit"
              className="rounded-full border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-red-100 transition hover:border-red-400/50 hover:bg-red-500/20"
            >
              Sign Out
            </button>
          </Form>
        </div>
      </div>

      <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Imported episodes" value={formatNumber(summary.episodeCount)} />
        <SummaryCard label="Corpus words" value={formatNumber(summary.totalWords)} />
        <SummaryCard label="Transcript chunks" value={formatNumber(summary.chunkCount)} />
        <SummaryCard
          label="Embedded chunks"
          value={formatNumber(summary.embeddedChunkCount)}
          detail={formatPercent(embeddingCoverage)}
        />
        <SummaryCard label="Episodes used" value={formatNumber(summary.episodesUsedCount)} />
        <SummaryCard label="Story references" value={formatNumber(summary.storyReferenceCount)} />
      </section>

      <section className="mt-8 rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6">
        <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
          <article>
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
              Hybrid retrieval probe
            </p>
            <h2 className="mt-4 font-display text-3xl text-stone-50">
              Test chunk search before draft generation
            </h2>
            <p className="mt-4 text-sm leading-7 text-stone-300">
              This runs vector search against embedded chunks and fuses it with lexical transcript
              search. Use it to inspect whether the current corpus will pull the right source material
              before we build the story workflow.
            </p>

            <Form method="get" className="mt-6 space-y-4">
              {view.selectedEpisodeSlug ? (
                <input type="hidden" name="episode" value={view.selectedEpisodeSlug} />
              ) : null}

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
                  Query
                </span>
                <input
                  type="text"
                  name="search"
                  defaultValue={view.retrievalQuery}
                  placeholder="ex: false faces in domestic spaces"
                  className="mt-2 w-full rounded-[1.2rem] border border-stone-700 bg-stone-900 px-4 py-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-500 focus:border-amber-400/60"
                />
              </label>

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
                  Fear filter
                </span>
                <select
                  name="fear"
                  defaultValue={view.selectedFearSlug ?? ""}
                  className="mt-2 w-full rounded-[1.2rem] border border-stone-700 bg-stone-900 px-4 py-3 text-sm text-stone-100 outline-none transition focus:border-amber-400/60"
                >
                  <option value="">All fears</option>
                  {fearOptions.map((fear) => (
                    <option key={fear.slug} value={fear.slug}>
                      {fear.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-3 rounded-[1.2rem] border border-stone-800 bg-stone-900/70 px-4 py-3 text-sm text-stone-300">
                <input
                  type="checkbox"
                  name="scope"
                  value="selected"
                  defaultChecked={view.selectedEpisodeOnly}
                  className="h-4 w-4 rounded border-stone-600 bg-stone-950 text-amber-400"
                />
                Limit retrieval to the selected episode
              </label>

              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  className="rounded-full border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-amber-100 transition hover:border-amber-300/60 hover:bg-amber-500/20"
                >
                  Probe retrieval
                </button>
                {(view.retrievalQuery || view.selectedFearSlug || view.selectedEpisodeOnly) && (
                  <Link
                    to={buildAccountHref({ episode: view.selectedEpisodeSlug })}
                    className="rounded-full border border-stone-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-200 transition hover:border-stone-500"
                  >
                    Clear probe
                  </Link>
                )}
              </div>
            </Form>
          </article>

          <article className="rounded-[1.6rem] border border-stone-800 bg-stone-900/75 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full border border-stone-700 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-300">
                {formatPercent(embeddingCoverage)} embedding coverage
              </span>
              {retrieval?.usage ? (
                <span className="rounded-full border border-emerald-500/30 px-3 py-1 text-xs uppercase tracking-[0.22em] text-emerald-200">
                  {formatNumber(retrieval.usage.totalTokens)} embedding tokens
                </span>
              ) : null}
              {retrieval ? (
                <>
                  <span className="rounded-full border border-stone-700 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-300">
                    {retrieval.vectorHitCount} vector hits
                  </span>
                  <span className="rounded-full border border-stone-700 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-300">
                    {retrieval.lexicalHitCount} lexical hits
                  </span>
                </>
              ) : null}
            </div>

            {view.retrievalError ? (
              <p className="mt-6 rounded-[1.3rem] border border-red-500/30 bg-red-500/10 px-4 py-4 text-sm leading-6 text-red-100">
                Retrieval failed: {view.retrievalError}
              </p>
            ) : retrieval ? (
              retrieval.results.length > 0 ? (
                <div className="mt-6 space-y-3">
                  {retrieval.warnings.length > 0 ? (
                    <div className="rounded-[1.3rem] border border-amber-500/30 bg-amber-500/10 px-4 py-4 text-sm leading-6 text-amber-100">
                      {retrieval.warnings.join(" ")}
                    </div>
                  ) : null}

                  {retrieval.results.map((result) => (
                    <article
                      key={result.chunkId}
                      className="rounded-[1.4rem] border border-stone-800 bg-stone-950/80 p-4"
                    >
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <p className="text-xs uppercase tracking-[0.24em] text-stone-500">
                            MAG {String(result.episodeNumber).padStart(3, "0")} chunk{" "}
                            {result.chunkIndex + 1}
                          </p>
                          <h3 className="mt-2 font-display text-2xl text-stone-50">
                            {result.episodeTitle}
                          </h3>
                        </div>

                        <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.2em]">
                          {result.sources.map((source) => (
                            <span
                              key={source}
                              className="rounded-full border border-stone-700 px-2 py-1 text-stone-200"
                            >
                              {source}
                            </span>
                          ))}
                          {result.similarity !== null ? (
                            <span className="rounded-full border border-cyan-500/30 px-2 py-1 text-cyan-100">
                              sim {result.similarity.toFixed(3)}
                            </span>
                          ) : null}
                          {result.lexicalScore !== null ? (
                            <span className="rounded-full border border-emerald-500/30 px-2 py-1 text-emerald-100">
                              lex {result.lexicalScore.toFixed(2)}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      {result.fearSlugs.length > 0 ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {result.fearSlugs.map((fearSlug) => (
                            <FearTag key={fearSlug} value={fearSlug} />
                          ))}
                        </div>
                      ) : null}

                      <p className="mt-4 text-sm leading-7 text-stone-300">{result.excerpt}</p>

                      <div className="mt-4">
                        <Link
                          to={buildAccountHref({
                            episode: result.episodeSlug,
                            fear: view.selectedFearSlug,
                            scope: view.selectedEpisodeOnly ? "selected" : null,
                            search: view.retrievalQuery,
                          })}
                          className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-300 transition hover:text-amber-200"
                        >
                          Open episode detail
                        </Link>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="mt-6 text-sm leading-7 text-stone-400">
                  No chunk matches yet. Try a more concrete phrase, remove the fear filter, or finish
                  embedding the corpus before judging retrieval quality.
                </p>
              )
            ) : (
              <p className="mt-6 text-sm leading-7 text-stone-400">
                Run a probe query to inspect ranked chunk matches and see how much of the corpus is
                already embedded.
              </p>
            )}
          </article>
        </div>
      </section>

      {episodes.length === 0 ? (
        <section className="mt-8 rounded-[2rem] border border-dashed border-stone-700 bg-stone-950/60 p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">
            Nothing imported yet
          </p>
          <h2 className="mt-4 font-display text-3xl text-stone-50">Run the transcript import first.</h2>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-300">
            Once the initial schema is applied and your local `.dev.vars` has a real Supabase service
            role key, run `npm run import:transcripts -- --dry-run` and then `npm run import:transcripts`.
          </p>
        </section>
      ) : (
        <section className="mt-8 grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="rounded-[2rem] border border-stone-800/80 bg-stone-950/70 p-4">
            <div className="border-b border-stone-800 px-3 pb-4">
              <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                Imported archive
              </p>
              <p className="mt-2 text-sm text-stone-300">
                {episodes.length} cleaned episodes ready for retrieval and metadata review.
              </p>
            </div>

            <div className="mt-4 max-h-[72vh] space-y-3 overflow-y-auto pr-1">
              {episodes.map((episode) => {
                const isActive = selectedEpisode?.id === episode.id;

                return (
                  <Link
                    key={episode.id}
                    to={buildAccountHref({
                      episode: episode.slug,
                      fear: view.selectedFearSlug,
                      scope: view.selectedEpisodeOnly ? "selected" : null,
                      search: view.retrievalQuery,
                    })}
                    className={`block rounded-[1.4rem] border p-4 transition ${
                      isActive
                        ? "border-amber-400/40 bg-amber-500/10"
                        : "border-stone-800 bg-stone-900/70 hover:border-stone-600"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-xs uppercase tracking-[0.26em] text-stone-500">
                          MAG {String(episode.episodeNumber).padStart(3, "0")}
                        </p>
                        <h2 className="mt-3 font-display text-2xl text-stone-50">{episode.title}</h2>
                      </div>
                      <span className="rounded-full border border-stone-700 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-stone-300">
                        {episode.storyReferenceCount} refs
                      </span>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.18em] text-stone-400">
                      <span className="rounded-full bg-stone-800 px-2 py-1">
                        {formatNumber(episode.wordCount ?? 0)} words
                      </span>
                      <span className="rounded-full bg-stone-800 px-2 py-1">
                        {episode.importStatus}
                      </span>
                      {episode.contentWarnings.length > 0 ? (
                        <span className="rounded-full bg-stone-800 px-2 py-1">
                          {episode.contentWarnings.length} warnings
                        </span>
                      ) : null}
                    </div>

                    {episode.hook ? (
                      <p className="mt-4 text-sm leading-6 text-stone-300">{episode.hook}</p>
                    ) : (
                      <p className="mt-4 text-sm leading-6 text-stone-400">
                        No generated hook yet. Deterministic transcript import only.
                      </p>
                    )}
                  </Link>
                );
              })}
            </div>
          </aside>

          {selectedEpisode ? (
            <section className="space-y-6">
              <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                  Selected episode
                </p>
                <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-sm uppercase tracking-[0.26em] text-amber-300">
                      MAG {String(selectedEpisode.episodeNumber).padStart(3, "0")}
                    </p>
                    <h2 className="mt-3 font-display text-5xl text-stone-50">
                      {selectedEpisode.title}
                    </h2>
                    <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-300">
                      {selectedEpisode.summary ??
                        "No generated summary yet. This episode is available with cleaned transcript text and deterministic metadata only."}
                    </p>
                  </div>

                  <div className="rounded-[1.5rem] border border-stone-800 bg-stone-900/75 p-4 text-sm text-stone-300">
                    <p>
                      <span className="text-stone-500">Source file:</span>{" "}
                      {selectedEpisode.sourceFilename}
                    </p>
                    <p className="mt-2">
                      <span className="text-stone-500">Primary fear:</span>{" "}
                      {selectedEpisode.primaryFearSlug ?? "Not assigned"}
                    </p>
                    <p className="mt-2">
                      <span className="text-stone-500">Last used:</span>{" "}
                      {formatDate(selectedEpisode.lastUsedAt)}
                    </p>
                  </div>
                </div>

                <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <DetailCard label="Word count" value={formatNumber(selectedEpisode.wordCount ?? 0)} />
                  <DetailCard
                    label="Character count"
                    value={formatNumber(selectedEpisode.characterCount ?? 0)}
                  />
                  <DetailCard
                    label="Story references"
                    value={formatNumber(selectedEpisode.storyReferenceCount)}
                  />
                  <DetailCard
                    label="Story projects"
                    value={formatNumber(selectedEpisode.storyProjectCount)}
                  />
                </div>

                <div className="mt-6 grid gap-4 lg:grid-cols-2">
                  <article className="rounded-[1.5rem] border border-stone-800 bg-stone-900/70 p-4">
                    <p className="text-xs uppercase tracking-[0.26em] text-stone-500">
                      Content warnings
                    </p>
                    {selectedEpisode.contentWarnings.length > 0 ? (
                      <ul className="mt-4 space-y-2 text-sm text-stone-300">
                        {selectedEpisode.contentWarnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-4 text-sm text-stone-400">No warnings extracted.</p>
                    )}
                  </article>

                  <article className="rounded-[1.5rem] border border-stone-800 bg-stone-900/70 p-4">
                    <p className="text-xs uppercase tracking-[0.26em] text-stone-500">
                      Secondary fears
                    </p>
                    {selectedEpisode.secondaryFearSlugs.length > 0 ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {selectedEpisode.secondaryFearSlugs.map((fear) => (
                          <span
                            key={fear}
                            className="rounded-full bg-stone-800 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-200"
                          >
                            {fear}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-4 text-sm text-stone-400">No secondary fears tagged yet.</p>
                    )}
                  </article>
                </div>
              </article>

              <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                      Story provenance
                    </p>
                    <h3 className="mt-3 font-display text-3xl text-stone-50">
                      Where this episode has already been used
                    </h3>
                  </div>
                  <span className="rounded-full border border-stone-700 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-300">
                    {selectedEpisodeReferences.length} links
                  </span>
                </div>

                {selectedEpisodeReferences.length > 0 ? (
                  <div className="mt-6 grid gap-3">
                    {selectedEpisodeReferences.map((reference) => (
                      <article
                        key={reference.storyVersionId}
                        className="rounded-[1.4rem] border border-stone-800 bg-stone-900/70 p-4"
                      >
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div>
                            <p className="text-xs uppercase tracking-[0.24em] text-stone-500">
                              Story version {reference.versionNumber}
                            </p>
                            <h4 className="mt-2 font-display text-2xl text-stone-50">
                              {reference.storyTitle}
                            </h4>
                            <p className="mt-3 text-sm text-stone-300">
                              Visibility: project {reference.storyVisibility}, version{" "}
                              {reference.versionVisibility}
                            </p>
                          </div>
                          <div className="text-sm text-stone-300">
                            <p>
                              <span className="text-stone-500">Slug:</span> {reference.storySlug}
                            </p>
                            <p className="mt-2">
                              <span className="text-stone-500">Linked:</span>{" "}
                              {formatDate(reference.linkedAt)}
                            </p>
                            <p className="mt-2">
                              <span className="text-stone-500">Relevance:</span>{" "}
                              {reference.relevanceScore !== null
                                ? reference.relevanceScore.toFixed(3)
                                : "Not scored"}
                            </p>
                          </div>
                        </div>

                        {reference.usageReason ? (
                          <p className="mt-4 text-sm leading-6 text-stone-300">
                            {reference.usageReason}
                          </p>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="mt-6 text-sm leading-7 text-stone-400">
                    No generated stories reference this episode yet. Once story drafting lands, links back
                    to source episodes will appear here.
                  </p>
                )}
              </article>

              <section className="grid gap-6 xl:grid-cols-2">
                <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6">
                  <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                    Deterministic metadata
                  </p>
                  <pre className="mt-4 overflow-x-auto rounded-[1.4rem] border border-stone-800 bg-stone-900/80 p-4 text-xs leading-6 text-stone-200">
                    {JSON.stringify(selectedEpisode.deterministicMetadata, null, 2)}
                  </pre>
                </article>

                <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6">
                  <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                    Generated metadata
                  </p>
                  <pre className="mt-4 overflow-x-auto rounded-[1.4rem] border border-stone-800 bg-stone-900/80 p-4 text-xs leading-6 text-stone-200">
                    {JSON.stringify(selectedEpisode.generatedMetadata, null, 2)}
                  </pre>
                </article>
              </section>

              <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                      Transcript text
                    </p>
                    <h3 className="mt-3 font-display text-3xl text-stone-50">
                      Cleaned source text currently stored for retrieval
                    </h3>
                  </div>
                  <span className="rounded-full border border-stone-700 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-300">
                    {selectedEpisode.importStatus}
                  </span>
                </div>
                <pre className="mt-6 max-h-[900px] overflow-auto whitespace-pre-wrap rounded-[1.5rem] border border-stone-800 bg-stone-900/75 p-5 text-sm leading-7 text-stone-200">
                  {selectedEpisode.transcriptText}
                </pre>
              </article>
            </section>
          ) : null}
        </section>
      )}
    </main>
  );
}

function SummaryCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <article className="rounded-[1.6rem] border border-stone-800/80 bg-stone-950/70 p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">{label}</p>
      <p className="mt-4 font-display text-4xl text-stone-50">{value}</p>
      {detail ? <p className="mt-2 text-xs uppercase tracking-[0.22em] text-stone-400">{detail}</p> : null}
    </article>
  );
}

function DetailCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-[1.3rem] border border-stone-800 bg-stone-900/70 p-4">
      <p className="text-xs uppercase tracking-[0.24em] text-stone-500">{label}</p>
      <p className="mt-3 font-display text-3xl text-stone-50">{value}</p>
    </article>
  );
}

function formatNumber(value: number) {
  return value.toLocaleString();
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDate(value: string | null) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function FearTag({ value }: { value: string }) {
  return (
    <span className="rounded-full bg-stone-800 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-200">
      {value}
    </span>
  );
}

function buildAccountHref({
  episode,
  fear,
  scope,
  search,
}: {
  episode?: string | null;
  fear?: string | null;
  scope?: string | null;
  search?: string | null;
}) {
  const params = new URLSearchParams();

  if (episode) {
    params.set("episode", episode);
  }

  if (search) {
    params.set("search", search);
  }

  if (fear) {
    params.set("fear", fear);
  }

  if (scope) {
    params.set("scope", scope);
  }

  const query = params.toString();
  return query.length > 0 ? `/account?${query}` : "/account";
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
