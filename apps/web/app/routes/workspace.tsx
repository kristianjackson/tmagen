import { data, Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/workspace";
import type { AppEnv } from "../lib/env.server";
import {
  runChunkRetrievalProbe,
  type RetrievalProbe,
} from "../lib/retrieval.server";
import { createSupabaseAdminClient } from "../lib/supabase/admin.server";
import { getViewer } from "../lib/viewer.server";

const CANON_MODES = ["strict", "adjacent", "au"] as const;
const CAST_POLICIES = ["none", "cameo", "full"] as const;
const VISIBILITIES = ["private", "unlisted", "public"] as const;

type FearOption = {
  slug: string;
  name: string;
  description: string;
};

type StoryProjectSummary = {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  seedPrompt: string | null;
  canonMode: (typeof CANON_MODES)[number];
  castPolicy: (typeof CAST_POLICIES)[number];
  selectedFearSlugs: string[];
  visibility: (typeof VISIBILITIES)[number];
  status: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  latestVersionNumber: number | null;
};

type StoryVersionSummary = {
  id: string;
  storyProjectId: string;
  versionNumber: number;
  visibility: string;
  createdAt: string;
  revisionNotes: string | null;
  modelName: string | null;
};

type ActionData = {
  error: string;
  intent: "create-project" | "update-project";
  fields: {
    title?: string;
    summary?: string | null;
    seedPrompt?: string | null;
    canonMode?: string;
    castPolicy?: string;
    visibility?: string;
    projectId?: string;
    selectedFearSlugs?: string[];
  };
};

export function meta({}: Route.MetaArgs) {
  return [
    { title: "TMAGen | Creator Workspace" },
    {
      name: "description",
      content:
        "Private TMAGen workspace for shaping story briefs, choosing fears and canon constraints, and previewing retrieval before draft generation.",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as AppEnv;
  const { responseHeaders, supabase, viewer } = await getViewer({ env, request });

  if (!viewer) {
    return redirect("/auth?next=/workspace", { headers: responseHeaders });
  }

  const adminClient = createSupabaseAdminClient(env);
  const url = new URL(request.url);
  const selectedProjectSlug = url.searchParams.get("project");
  const flash =
    url.searchParams.get("created") === "1"
      ? "Story brief created."
      : url.searchParams.get("saved") === "1"
        ? "Story brief saved."
        : null;

  const [{ data: fearRows, error: fearsError }, { data: projectRows, error: projectsError }] =
    await Promise.all([
      supabase
        .from("fears")
        .select("slug, name, description")
        .order("sort_order", { ascending: true }),
      supabase
        .from("story_projects")
        .select(
          "id, title, slug, summary, seed_prompt, canon_mode, cast_policy, selected_fear_slugs, visibility, status, published_at, created_at, updated_at",
        )
        .order("updated_at", { ascending: false }),
    ]);

  if (fearsError) {
    throw data(
      { message: `Failed to load fear taxonomy: ${fearsError.message}` },
      { status: 500, headers: responseHeaders },
    );
  }

  if (projectsError) {
    throw data(
      { message: `Failed to load story projects: ${projectsError.message}` },
      { status: 500, headers: responseHeaders },
    );
  }

  const fearOptions: FearOption[] = (fearRows ?? []).map((row) => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
  }));

  const projectIds = (projectRows ?? []).map((row) => row.id);
  let versionRows: StoryVersionSummary[] = [];

  if (projectIds.length > 0) {
    const { data: versionData, error: versionsError } = await supabase
      .from("story_versions")
      .select(
        "id, story_project_id, version_number, visibility, created_at, revision_notes, model_name",
      )
      .in("story_project_id", projectIds)
      .order("created_at", { ascending: false });

    if (versionsError) {
      throw data(
        { message: `Failed to load story versions: ${versionsError.message}` },
        { status: 500, headers: responseHeaders },
      );
    }

    versionRows = (versionData ?? []).map((row) => ({
      id: row.id,
      storyProjectId: row.story_project_id,
      versionNumber: row.version_number,
      visibility: row.visibility,
      createdAt: row.created_at,
      revisionNotes: row.revision_notes,
      modelName: row.model_name,
    }));
  }

  const versionsByProject = new Map<string, StoryVersionSummary[]>();
  for (const version of versionRows) {
    const current = versionsByProject.get(version.storyProjectId) ?? [];
    current.push(version);
    versionsByProject.set(version.storyProjectId, current);
  }

  const projects: StoryProjectSummary[] = (projectRows ?? []).map((row) => {
    const projectVersions = versionsByProject.get(row.id) ?? [];

    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      summary: row.summary,
      seedPrompt: row.seed_prompt,
      canonMode: row.canon_mode,
      castPolicy: row.cast_policy,
      selectedFearSlugs: row.selected_fear_slugs ?? [],
      visibility: row.visibility,
      status: row.status,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      versionCount: projectVersions.length,
      latestVersionNumber: projectVersions[0]?.versionNumber ?? null,
    };
  });

  const selectedProject =
    projects.find((project) => project.slug === selectedProjectSlug) ?? projects[0] ?? null;
  const selectedProjectVersions = selectedProject
    ? versionsByProject.get(selectedProject.id) ?? []
    : [];

  let retrieval: RetrievalProbe | null = null;

  if (selectedProject) {
    const retrievalQuery = buildProjectRetrievalQuery(selectedProject);

    if (retrievalQuery) {
      retrieval = await runChunkRetrievalProbe({
        adminClient,
        env,
        query: retrievalQuery,
        fearSlugs: selectedProject.selectedFearSlugs,
        matchCount: 8,
      }).catch(() => null);
    }
  }

  return data(
    {
      fearOptions,
      flash,
      projects,
      retrieval,
      selectedProject,
      selectedProjectVersions,
      summary: {
        draftVersionCount: versionRows.length,
        projectCount: projects.length,
        publicProjectCount: projects.filter((project) => project.visibility === "public").length,
        seededProjectCount: projects.filter((project) => buildProjectRetrievalQuery(project)).length,
      },
      viewer,
    },
    { headers: responseHeaders },
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as AppEnv;
  const { responseHeaders, supabase, viewer } = await getViewer({ env, request });

  if (!viewer) {
    return redirect("/auth?next=/workspace", { headers: responseHeaders });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const fields = {
    canonMode: String(formData.get("canonMode") ?? "adjacent"),
    castPolicy: String(formData.get("castPolicy") ?? "cameo"),
    projectId: String(formData.get("projectId") ?? ""),
    seedPrompt: normalizeTextarea(formData.get("seedPrompt")),
    selectedFearSlugs: formData
      .getAll("selectedFearSlugs")
      .map((value) => String(value))
      .filter(Boolean),
    summary: normalizeTextarea(formData.get("summary")),
    title: normalizeTitle(formData.get("title")),
    visibility: String(formData.get("visibility") ?? "private"),
  };

  const fearSlugs = await loadFearSlugSet(supabase);
  const selectedFearSlugs = dedupeStrings(
    fields.selectedFearSlugs.filter((fearSlug) => fearSlugs.has(fearSlug)),
  );

  if (!fields.title) {
    return data<ActionData>(
      {
        error: "Title is required.",
        fields: {
          ...fields,
          selectedFearSlugs,
        },
        intent: intent === "update-project" ? "update-project" : "create-project",
      },
      { headers: responseHeaders, status: 400 },
    );
  }

  if (!isAllowed(CANON_MODES, fields.canonMode) || !isAllowed(CAST_POLICIES, fields.castPolicy)) {
    return data<ActionData>(
      {
        error: "The selected canon or cast option is invalid.",
        fields: {
          ...fields,
          selectedFearSlugs,
        },
        intent: intent === "update-project" ? "update-project" : "create-project",
      },
      { headers: responseHeaders, status: 400 },
    );
  }

  if (!isAllowed(VISIBILITIES, fields.visibility)) {
    return data<ActionData>(
      {
        error: "The selected visibility is invalid.",
        fields: {
          ...fields,
          selectedFearSlugs,
        },
        intent: intent === "update-project" ? "update-project" : "create-project",
      },
      { headers: responseHeaders, status: 400 },
    );
  }

  if (intent === "create-project") {
    const slug = await reserveUniqueStorySlug({
      creatorId: viewer.user.id,
      supabase,
      title: fields.title,
    });
    const { error } = await supabase.from("story_projects").insert({
      canon_mode: fields.canonMode,
      cast_policy: fields.castPolicy,
      creator_id: viewer.user.id,
      seed_prompt: fields.seedPrompt,
      selected_fear_slugs: selectedFearSlugs,
      slug,
      summary: fields.summary,
      title: fields.title,
      visibility: fields.visibility,
    });

    if (error) {
      return data<ActionData>(
        {
          error: `Failed to create story brief: ${error.message}`,
          fields: {
            ...fields,
            selectedFearSlugs,
          },
          intent: "create-project",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    return redirect(`/workspace?project=${slug}&created=1`, { headers: responseHeaders });
  }

  if (intent === "update-project") {
    if (!fields.projectId) {
      return data<ActionData>(
        {
          error: "Missing story project.",
          fields: {
            ...fields,
            selectedFearSlugs,
          },
          intent: "update-project",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { data: updatedProject, error } = await supabase
      .from("story_projects")
      .update({
        canon_mode: fields.canonMode,
        cast_policy: fields.castPolicy,
        seed_prompt: fields.seedPrompt,
        selected_fear_slugs: selectedFearSlugs,
        summary: fields.summary,
        title: fields.title,
        visibility: fields.visibility,
      })
      .eq("id", fields.projectId)
      .select("slug")
      .single();

    if (error || !updatedProject) {
      return data<ActionData>(
        {
          error: `Failed to save story brief: ${error?.message ?? "Unknown error"}`,
          fields: {
            ...fields,
            selectedFearSlugs,
          },
          intent: "update-project",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    return redirect(`/workspace?project=${updatedProject.slug}&saved=1`, {
      headers: responseHeaders,
    });
  }

  return data<ActionData>(
    {
      error: "Unknown workspace action.",
      fields: {
        ...fields,
        selectedFearSlugs,
      },
      intent: "create-project",
    },
    { headers: responseHeaders, status: 400 },
  );
}

export default function Workspace({ actionData, loaderData }: Route.ComponentProps) {
  const { fearOptions, flash, projects, retrieval, selectedProject, selectedProjectVersions, summary, viewer } =
    loaderData;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const createFields =
    actionData?.intent === "create-project"
      ? actionData.fields
      : {
          canonMode: "adjacent",
          castPolicy: "cameo",
          seedPrompt: "",
          selectedFearSlugs: [],
          title: "",
          visibility: "private",
        };
  const editFields =
    actionData?.intent === "update-project" && selectedProject
      ? {
          canonMode: actionData.fields.canonMode ?? selectedProject.canonMode,
          castPolicy: actionData.fields.castPolicy ?? selectedProject.castPolicy,
          seedPrompt: actionData.fields.seedPrompt ?? selectedProject.seedPrompt ?? "",
          selectedFearSlugs:
            actionData.fields.selectedFearSlugs ?? selectedProject.selectedFearSlugs,
          summary: actionData.fields.summary ?? selectedProject.summary ?? "",
          title: actionData.fields.title ?? selectedProject.title,
          visibility: actionData.fields.visibility ?? selectedProject.visibility,
        }
      : selectedProject
        ? {
            canonMode: selectedProject.canonMode,
            castPolicy: selectedProject.castPolicy,
            seedPrompt: selectedProject.seedPrompt ?? "",
            selectedFearSlugs: selectedProject.selectedFearSlugs,
            summary: selectedProject.summary ?? "",
            title: selectedProject.title,
            visibility: selectedProject.visibility,
          }
        : null;

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1480px] px-6 py-10 lg:px-10">
      <div className="flex flex-col gap-4 rounded-[2rem] border border-stone-800/80 bg-stone-950/70 p-6 backdrop-blur lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-300">
            Creator Workspace
          </p>
          <h1 className="mt-4 font-display text-4xl text-stone-50">
            Shape the brief before draft generation exists
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-300">
            Signed in as {viewer.profile?.displayName ?? viewer.user.displayName}. This route stores
            project-level canon controls, fear selection, and prompt seeds under your account so the
            later drafting step has a stable place to start.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="rounded-full border border-stone-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-200 transition hover:border-stone-500"
          >
            Public Feed
          </Link>
          <Link
            to="/account"
            className="rounded-full border border-stone-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-200 transition hover:border-stone-500"
          >
            Transcript Dashboard
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

      {flash ? (
        <div className="mt-6 rounded-[1.5rem] border border-emerald-500/30 bg-emerald-500/10 px-5 py-4 text-sm text-emerald-100">
          {flash}
        </div>
      ) : null}

      {actionData?.error ? (
        <div className="mt-6 rounded-[1.5rem] border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm text-red-100">
          {actionData.error}
        </div>
      ) : null}

      <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <WorkspaceSummaryCard label="Story briefs" value={formatNumber(summary.projectCount)} />
        <WorkspaceSummaryCard
          label="Draft versions"
          value={formatNumber(summary.draftVersionCount)}
        />
        <WorkspaceSummaryCard
          label="Seeded briefs"
          value={formatNumber(summary.seededProjectCount)}
        />
        <WorkspaceSummaryCard
          label="Public projects"
          value={formatNumber(summary.publicProjectCount)}
        />
      </section>

      <section className="mt-8 grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="space-y-6">
          <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-stone-500">
              New story brief
            </p>
            <Form method="post" className="mt-5 space-y-4">
              <input type="hidden" name="intent" value="create-project" />

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
                  Title
                </span>
                <input
                  type="text"
                  name="title"
                  defaultValue={createFields.title}
                  placeholder="Statement Regarding the Last Empty Seat"
                  className="mt-2 w-full rounded-[1.2rem] border border-stone-700 bg-stone-900 px-4 py-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-500 focus:border-amber-400/60"
                />
              </label>

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
                  Seed prompt
                </span>
                <textarea
                  name="seedPrompt"
                  defaultValue={createFields.seedPrompt ?? ""}
                  rows={5}
                  placeholder="A late train carriage where one passenger has the wrong face and everyone else acts like that is normal."
                  className="mt-2 w-full rounded-[1.2rem] border border-stone-700 bg-stone-900 px-4 py-3 text-sm leading-7 text-stone-100 outline-none transition placeholder:text-stone-500 focus:border-amber-400/60"
                />
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  label="Canon mode"
                  name="canonMode"
                  options={CANON_MODES}
                  value={createFields.canonMode ?? "adjacent"}
                />
                <SelectField
                  label="Visibility"
                  name="visibility"
                  options={VISIBILITIES}
                  value={createFields.visibility ?? "private"}
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full rounded-full border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-xs font-semibold uppercase tracking-[0.22em] text-amber-100 transition hover:border-amber-300/60 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? "Saving..." : "Create brief"}
              </button>
            </Form>
          </article>

          <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-4">
            <div className="border-b border-stone-800 px-3 pb-4">
              <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                Your projects
              </p>
              <p className="mt-2 text-sm text-stone-300">
                {projects.length > 0
                  ? "Pick a brief to refine the canon controls and preview source retrieval."
                  : "Create the first story brief to start shaping the workspace state."}
              </p>
            </div>

            <div className="mt-4 max-h-[70vh] space-y-3 overflow-y-auto pr-1">
              {projects.length > 0 ? (
                projects.map((project) => {
                  const isActive = selectedProject?.id === project.id;

                  return (
                    <Link
                      key={project.id}
                      to={buildWorkspaceHref(project.slug)}
                      className={`block rounded-[1.4rem] border p-4 transition ${
                        isActive
                          ? "border-amber-400/40 bg-amber-500/10"
                          : "border-stone-800 bg-stone-900/70 hover:border-stone-600"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xs uppercase tracking-[0.24em] text-stone-500">
                            {project.canonMode} canon
                          </p>
                          <h2 className="mt-3 font-display text-2xl text-stone-50">
                            {project.title}
                          </h2>
                        </div>
                        <span className="rounded-full border border-stone-700 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-stone-300">
                          v{project.latestVersionNumber ?? 0}
                        </span>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.18em] text-stone-400">
                        <span className="rounded-full bg-stone-800 px-2 py-1">
                          {project.visibility}
                        </span>
                        <span className="rounded-full bg-stone-800 px-2 py-1">
                          {project.versionCount} versions
                        </span>
                        <span className="rounded-full bg-stone-800 px-2 py-1">
                          {project.selectedFearSlugs.length} fears
                        </span>
                      </div>

                      <p className="mt-4 text-sm leading-6 text-stone-300">
                        {project.summary ??
                          project.seedPrompt ??
                          "No summary or prompt seed yet. This brief exists, but it is still hollow."}
                      </p>
                    </Link>
                  );
                })
              ) : (
                <div className="rounded-[1.4rem] border border-dashed border-stone-700 bg-stone-900/40 p-5 text-sm leading-7 text-stone-400">
                  Nothing saved yet. The transcript corpus is ready, but the creator-side brief layer is
                  just starting now.
                </div>
              )}
            </div>
          </article>
        </aside>

        <section className="space-y-6">
          {selectedProject ? (
            <>
              <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                      Selected brief
                    </p>
                    <h2 className="mt-4 font-display text-5xl text-stone-50">
                      {selectedProject.title}
                    </h2>
                    <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-300">
                      This is the durable project shell that later draft generation will target. The
                      fields below become the starting brief, and the retrieval preview uses them right
                      now so you can tune the constraints before any draft is written.
                    </p>
                  </div>

                  <div className="rounded-[1.5rem] border border-stone-800 bg-stone-900/75 p-4 text-sm text-stone-300">
                    <p>
                      <span className="text-stone-500">Slug:</span> {selectedProject.slug}
                    </p>
                    <p className="mt-2">
                      <span className="text-stone-500">Updated:</span>{" "}
                      {formatDate(selectedProject.updatedAt)}
                    </p>
                    <p className="mt-2">
                      <span className="text-stone-500">Versions:</span>{" "}
                      {formatNumber(selectedProject.versionCount)}
                    </p>
                  </div>
                </div>

                <Form method="post" className="mt-8 space-y-6">
                  <input type="hidden" name="intent" value="update-project" />
                  <input type="hidden" name="projectId" value={selectedProject.id} />

                  <div className="grid gap-6 lg:grid-cols-2">
                    <label className="block">
                      <span className="text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
                        Title
                      </span>
                      <input
                        type="text"
                        name="title"
                        defaultValue={editFields?.title}
                        className="mt-2 w-full rounded-[1.2rem] border border-stone-700 bg-stone-900 px-4 py-3 text-sm text-stone-100 outline-none transition focus:border-amber-400/60"
                      />
                    </label>

                    <label className="block">
                      <span className="text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
                        Summary
                      </span>
                      <input
                        type="text"
                        name="summary"
                        defaultValue={editFields?.summary}
                        placeholder="One-sentence brief for the eventual draft."
                        className="mt-2 w-full rounded-[1.2rem] border border-stone-700 bg-stone-900 px-4 py-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-500 focus:border-amber-400/60"
                      />
                    </label>
                  </div>

                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
                      Seed prompt
                    </span>
                    <textarea
                      name="seedPrompt"
                      rows={8}
                      defaultValue={editFields?.seedPrompt}
                      className="mt-2 w-full rounded-[1.2rem] border border-stone-700 bg-stone-900 px-4 py-3 text-sm leading-7 text-stone-100 outline-none transition placeholder:text-stone-500 focus:border-amber-400/60"
                    />
                  </label>

                  <div className="grid gap-4 md:grid-cols-3">
                    <SelectField
                      label="Canon mode"
                      name="canonMode"
                      options={CANON_MODES}
                      value={editFields?.canonMode ?? selectedProject.canonMode}
                    />
                    <SelectField
                      label="Cast policy"
                      name="castPolicy"
                      options={CAST_POLICIES}
                      value={editFields?.castPolicy ?? selectedProject.castPolicy}
                    />
                    <SelectField
                      label="Visibility"
                      name="visibility"
                      options={VISIBILITIES}
                      value={editFields?.visibility ?? selectedProject.visibility}
                    />
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
                      Fear selection
                    </p>
                    <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {fearOptions.map((fear) => (
                        <label
                          key={fear.slug}
                          className="flex gap-3 rounded-[1.2rem] border border-stone-800 bg-stone-900/75 px-4 py-3 text-sm text-stone-300"
                        >
                          <input
                            type="checkbox"
                            name="selectedFearSlugs"
                            value={fear.slug}
                            defaultChecked={
                              editFields?.selectedFearSlugs.includes(fear.slug) ?? false
                            }
                            className="mt-1 h-4 w-4 rounded border-stone-600 bg-stone-950 text-amber-400"
                          />
                          <span>
                            <span className="block font-semibold text-stone-100">{fear.name}</span>
                            <span className="mt-1 block text-xs leading-6 text-stone-400">
                              {fear.description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="rounded-full border border-amber-400/40 bg-amber-500/10 px-5 py-3 text-xs font-semibold uppercase tracking-[0.22em] text-amber-100 transition hover:border-amber-300/60 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSubmitting ? "Saving..." : "Save brief"}
                  </button>
                </Form>
              </article>

              <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                      Retrieval preview
                    </p>
                    <h3 className="mt-3 font-display text-3xl text-stone-50">
                      Source packet preview for this brief
                    </h3>
                  </div>

                  {retrieval ? (
                    <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.2em]">
                      <span className="rounded-full border border-stone-700 px-2 py-1 text-stone-300">
                        {retrieval.vectorHitCount} vector hits
                      </span>
                      <span className="rounded-full border border-stone-700 px-2 py-1 text-stone-300">
                        {retrieval.lexicalHitCount} lexical hits
                      </span>
                      {retrieval.usage ? (
                        <span className="rounded-full border border-emerald-500/30 px-2 py-1 text-emerald-100">
                          {formatNumber(retrieval.usage.totalTokens)} embedding tokens
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {retrieval ? (
                  <>
                    <p className="mt-4 text-sm leading-7 text-stone-300">
                      Query used: <span className="text-stone-100">{retrieval.query}</span>
                    </p>
                    {retrieval.fearSlugs.length > 0 ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {retrieval.fearSlugs.map((fearSlug) => (
                          <FearTag key={fearSlug} value={fearSlug} />
                        ))}
                      </div>
                    ) : null}

                    {retrieval.results.length > 0 ? (
                      <div className="mt-6 grid gap-3">
                        {retrieval.results.map((result) => (
                          <article
                            key={result.chunkId}
                            className="rounded-[1.4rem] border border-stone-800 bg-stone-900/75 p-4"
                          >
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                              <div>
                                <p className="text-xs uppercase tracking-[0.24em] text-stone-500">
                                  MAG {String(result.episodeNumber).padStart(3, "0")} chunk{" "}
                                  {result.chunkIndex + 1}
                                </p>
                                <h4 className="mt-2 font-display text-2xl text-stone-50">
                                  {result.episodeTitle}
                                </h4>
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
                              </div>
                            </div>

                            <div className="mt-4 flex flex-wrap gap-2">
                              {result.fearSlugs.map((fearSlug) => (
                                <FearTag key={fearSlug} value={fearSlug} />
                              ))}
                            </div>

                            <p className="mt-4 text-sm leading-7 text-stone-300">{result.excerpt}</p>
                            <p className="mt-4 text-xs uppercase tracking-[0.22em] text-stone-500">
                              Similarity {result.similarity?.toFixed(3) ?? "n/a"} · lexical{" "}
                              {result.lexicalScore?.toFixed(2) ?? "n/a"}
                            </p>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-6 text-sm leading-7 text-stone-400">
                        The brief did not return any source material yet. Tighten the seed prompt or
                        remove fear constraints before judging the generation path.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="mt-6 text-sm leading-7 text-stone-400">
                    Add a seed prompt or summary first. Once the brief has some shape, retrieval
                    preview will show the chunks most likely to ground the future draft.
                  </p>
                )}
              </article>

              <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                      Story versions
                    </p>
                    <h3 className="mt-3 font-display text-3xl text-stone-50">
                      Immutable drafts will appear here
                    </h3>
                  </div>
                  <span className="rounded-full border border-stone-700 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-300">
                    {selectedProjectVersions.length} versions
                  </span>
                </div>

                {selectedProjectVersions.length > 0 ? (
                  <div className="mt-6 grid gap-3">
                    {selectedProjectVersions.map((version) => (
                      <article
                        key={version.id}
                        className="rounded-[1.4rem] border border-stone-800 bg-stone-900/70 p-4"
                      >
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div>
                            <p className="text-xs uppercase tracking-[0.24em] text-stone-500">
                              Version {version.versionNumber}
                            </p>
                            <p className="mt-2 text-sm text-stone-300">
                              {version.modelName ?? "Model not captured yet"}
                            </p>
                          </div>
                          <div className="text-sm text-stone-300">
                            <p>
                              <span className="text-stone-500">Visibility:</span>{" "}
                              {version.visibility}
                            </p>
                            <p className="mt-2">
                              <span className="text-stone-500">Created:</span>{" "}
                              {formatDate(version.createdAt)}
                            </p>
                          </div>
                        </div>

                        {version.revisionNotes ? (
                          <p className="mt-4 text-sm leading-6 text-stone-300">
                            {version.revisionNotes}
                          </p>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="mt-6 text-sm leading-7 text-stone-400">
                    No draft exists yet. The next step after this workspace is generating the first
                    immutable story version with a captured prompt snapshot and retrieval snapshot.
                  </p>
                )}
              </article>
            </>
          ) : (
            <article className="rounded-[2rem] border border-dashed border-stone-700 bg-stone-950/60 p-8">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">
                No brief selected
              </p>
              <h2 className="mt-4 font-display text-3xl text-stone-50">
                Create the first story brief to activate the workspace.
              </h2>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-300">
                The corpus, metadata, and retrieval pipeline are in place. What is missing now is the
                user-owned brief that tells the system what kind of story to draft.
              </p>
            </article>
          )}
        </section>
      </section>
    </main>
  );
}

function SelectField({
  label,
  name,
  options,
  value,
}: {
  label: string;
  name: string;
  options: readonly string[];
  value: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
        {label}
      </span>
      <select
        name={name}
        defaultValue={value}
        className="mt-2 w-full rounded-[1.2rem] border border-stone-700 bg-stone-900 px-4 py-3 text-sm text-stone-100 outline-none transition focus:border-amber-400/60"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function WorkspaceSummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-[1.6rem] border border-stone-800/80 bg-stone-950/70 p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">{label}</p>
      <p className="mt-4 font-display text-4xl text-stone-50">{value}</p>
    </article>
  );
}

function FearTag({ value }: { value: string }) {
  return (
    <span className="rounded-full bg-stone-800 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-200">
      {value}
    </span>
  );
}

function buildWorkspaceHref(projectSlug: string) {
  return `/workspace?project=${encodeURIComponent(projectSlug)}`;
}

function buildProjectRetrievalQuery(project: {
  title: string;
  summary: string | null;
  seedPrompt: string | null;
}) {
  const prompt = normalizeTextarea(project.seedPrompt);

  if (prompt) {
    return prompt;
  }

  const summary = normalizeTextarea(project.summary);

  return [project.title.trim(), summary].filter(Boolean).join(". ");
}

async function loadFearSlugSet(
  supabase: Awaited<ReturnType<typeof getViewer>>["supabase"],
) {
  const { data, error } = await supabase.from("fears").select("slug");

  if (error) {
    throw new Error(`Failed to validate fear selection: ${error.message}`);
  }

  return new Set((data ?? []).map((row) => row.slug));
}

async function reserveUniqueStorySlug({
  creatorId,
  supabase,
  title,
}: {
  creatorId: string;
  supabase: Awaited<ReturnType<typeof getViewer>>["supabase"];
  title: string;
}) {
  const baseSlug = slugify(title);
  const { data, error } = await supabase
    .from("story_projects")
    .select("slug")
    .eq("creator_id", creatorId)
    .like("slug", `${baseSlug}%`);

  if (error) {
    throw new Error(`Failed to inspect existing story slugs: ${error.message}`);
  }

  const taken = new Set((data ?? []).map((row) => row.slug));

  if (!taken.has(baseSlug)) {
    return baseSlug;
  }

  let suffix = 2;
  while (taken.has(`${baseSlug}-${suffix}`)) {
    suffix += 1;
  }

  return `${baseSlug}-${suffix}`;
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return slug.length > 0 ? slug : "untitled-story";
}

function normalizeTitle(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, 140);
}

function normalizeTextarea(value: FormDataEntryValue | string | null) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function isAllowed<T extends readonly string[]>(values: T, candidate: string): candidate is T[number] {
  return values.includes(candidate);
}

function formatNumber(value: number) {
  return value.toLocaleString();
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
