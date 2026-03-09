import { data, Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/workspace";
import type { AppEnv } from "../lib/env.server";
import {
  buildPublishedStoryPath,
  buildPublishedStoryVersionPath,
} from "../lib/published-stories";
import {
  generateStoryVersionFromProject,
  reviseStoryVersionFromProject,
} from "../lib/story-generation.server";
import {
  runChunkRetrievalProbe,
  type RetrievalProbe,
} from "../lib/retrieval.server";
import { buildStoryRetrievalQuery } from "../lib/story-generation";
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
  parentVersionId: string | null;
  versionNumber: number;
  visibility: string;
  publishedAt: string | null;
  createdAt: string;
  revisionNotes: string | null;
  modelName: string | null;
  contentMarkdown: string;
  promptSnapshot: Record<string, unknown>;
  retrievalSnapshot: unknown[];
  generationMetadata: Record<string, unknown>;
};

type StoryEpisodeLink = {
  episodeId: string;
  episodeNumber: number;
  episodeSlug: string;
  episodeTitle: string;
  chunkIds: string[];
  relevanceScore: number | null;
  usageReason: string | null;
};

type ActionData = {
  error: string;
  intent:
    | "create-project"
    | "delete-draft"
    | "delete-project"
    | "generate-draft"
    | "publish-version"
    | "revise-draft"
    | "unpublish-version"
    | "update-project";
  fields: {
    title?: string;
    summary?: string | null;
    seedPrompt?: string | null;
    canonMode?: string;
    castPolicy?: string;
    visibility?: string;
    projectId?: string;
    revisionInstructions?: string | null;
    selectedFearSlugs?: string[];
    versionId?: string;
  };
};

export function meta({}: Route.MetaArgs) {
  return [
    { title: "TMAGen | Creator Workspace" },
    {
      name: "description",
      content:
        "Private TMAGen workspace for shaping story briefs, choosing fears and canon constraints, generating drafts, and inspecting retrieval provenance.",
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
  const didDeleteProject = url.searchParams.get("projectDeleted") === "1";
  const didDelete = url.searchParams.get("deleted") === "1";
  const didGenerate = url.searchParams.get("generated") === "1";
  const publishedVersion = url.searchParams.get("publishedVersion");
  const didRevise = url.searchParams.get("revised") === "1";
  const unpublishedVersion = url.searchParams.get("unpublishedVersion");
  const flash =
    url.searchParams.get("created") === "1"
      ? "Story brief created."
      : didDeleteProject
        ? "Story project deleted."
      : didDelete
        ? "Draft deleted."
      : didRevise
        ? "Draft revised."
      : publishedVersion
        ? `Version ${publishedVersion} published.`
      : unpublishedVersion
        ? `Version ${unpublishedVersion} unpublished.`
      : didGenerate
        ? "Draft generated."
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
        "id, story_project_id, parent_version_id, version_number, visibility, published_at, created_at, revision_notes, model_name, content_markdown, prompt_snapshot, retrieval_snapshot, generation_metadata",
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
      parentVersionId: row.parent_version_id,
      versionNumber: row.version_number,
      visibility: row.visibility,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      revisionNotes: row.revision_notes,
      modelName: row.model_name,
      contentMarkdown: row.content_markdown,
      promptSnapshot: asRecord(row.prompt_snapshot),
      retrievalSnapshot: Array.isArray(row.retrieval_snapshot) ? row.retrieval_snapshot : [],
      generationMetadata: asRecord(row.generation_metadata),
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
  const selectedVersion = selectedProjectVersions[0] ?? null;
  const selectedPublishedVersion =
    selectedProjectVersions.find((version) => version.publishedAt !== null) ?? null;
  let selectedVersionLinks: StoryEpisodeLink[] = [];

  if (selectedVersion) {
    const { data: linkRows, error: linksError } = await adminClient
      .from("story_episode_links")
      .select(
        "episode_id, chunk_ids, relevance_score, usage_reason, episodes!inner(episode_number, slug, title)",
      )
      .eq("story_version_id", selectedVersion.id)
      .order("relevance_score", { ascending: false });

    if (linksError) {
      throw data(
        { message: `Failed to load story provenance links: ${linksError.message}` },
        { status: 500, headers: responseHeaders },
      );
    }

    selectedVersionLinks = (linkRows ?? []).flatMap((row) => {
      const episode = Array.isArray(row.episodes) ? row.episodes[0] : row.episodes;

      if (!episode) {
        return [];
      }

      return [
        {
          episodeId: row.episode_id,
          episodeNumber: episode.episode_number,
          episodeSlug: episode.slug,
          episodeTitle: episode.title,
          chunkIds: row.chunk_ids ?? [],
          relevanceScore: row.relevance_score,
          usageReason: row.usage_reason,
        } satisfies StoryEpisodeLink,
      ];
    });
  }

  let retrieval: RetrievalProbe | null = null;

  if (selectedProject) {
    const retrievalQuery = buildStoryRetrievalQuery(selectedProject);

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
      didDeleteProject,
      didGenerate,
      didDelete,
      didRevise,
      projects,
      retrieval,
      selectedProject,
      selectedPublishedVersion,
      selectedVersion,
      selectedVersionLinks,
      selectedProjectVersions,
      summary: {
        draftVersionCount: versionRows.length,
        projectCount: projects.length,
        publicProjectCount: projects.filter((project) => project.visibility === "public").length,
        seededProjectCount: projects.filter((project) => buildStoryRetrievalQuery(project)).length,
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
    revisionInstructions: normalizeTextarea(formData.get("revisionInstructions")),
    seedPrompt: normalizeTextarea(formData.get("seedPrompt")),
    selectedFearSlugs: formData
      .getAll("selectedFearSlugs")
      .map((value) => String(value))
      .filter(Boolean),
    summary: normalizeTextarea(formData.get("summary")),
    title: normalizeTitle(formData.get("title")),
    versionId: String(formData.get("versionId") ?? ""),
    visibility: String(formData.get("visibility") ?? "private"),
  };

  const fearSlugs = await loadFearSlugSet(supabase);
  const selectedFearSlugs = dedupeStrings(
    fields.selectedFearSlugs.filter((fearSlug) => fearSlugs.has(fearSlug)),
  );

  if (intent === "generate-draft") {
    if (!fields.projectId) {
      return data<ActionData>(
        {
          error: "Missing story project.",
          fields: { projectId: fields.projectId },
          intent: "generate-draft",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { data: projectRow, error: projectError } = await supabase
      .from("story_projects")
      .select(
        "id, title, slug, summary, seed_prompt, canon_mode, cast_policy, selected_fear_slugs, visibility",
      )
      .eq("id", fields.projectId)
      .single();

    if (projectError || !projectRow) {
      return data<ActionData>(
        {
          error: `Failed to load story project: ${projectError?.message ?? "Unknown error"}`,
          fields: { projectId: fields.projectId },
          intent: "generate-draft",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    try {
      await generateStoryVersionFromProject({
        adminClient: createSupabaseAdminClient(env),
        env,
        fears: await loadFearOptions(supabase),
        project: {
          id: projectRow.id,
          title: projectRow.title,
          slug: projectRow.slug,
          summary: projectRow.summary,
          seedPrompt: projectRow.seed_prompt,
          canonMode: projectRow.canon_mode,
          castPolicy: projectRow.cast_policy,
          selectedFearSlugs: projectRow.selected_fear_slugs ?? [],
          visibility: projectRow.visibility,
        },
        supabase,
      });
    } catch (error) {
      return data<ActionData>(
        {
          error: formatError(error),
          fields: { projectId: fields.projectId },
          intent: "generate-draft",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    return redirect(`/workspace?project=${projectRow.slug}&generated=1#latest-draft`, {
      headers: responseHeaders,
    });
  }

  if (intent === "revise-draft") {
    if (!fields.projectId || !fields.versionId) {
      return data<ActionData>(
        {
          error: "Missing story project or draft version.",
          fields: {
            projectId: fields.projectId,
            revisionInstructions: fields.revisionInstructions,
            versionId: fields.versionId,
          },
          intent: "revise-draft",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    if (!fields.revisionInstructions) {
      return data<ActionData>(
        {
          error: "Revision instructions are required.",
          fields: {
            projectId: fields.projectId,
            revisionInstructions: fields.revisionInstructions,
            versionId: fields.versionId,
          },
          intent: "revise-draft",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { data: projectRow, error: projectError } = await supabase
      .from("story_projects")
      .select(
        "id, title, slug, summary, seed_prompt, canon_mode, cast_policy, selected_fear_slugs, visibility",
      )
      .eq("id", fields.projectId)
      .single();

    if (projectError || !projectRow) {
      return data<ActionData>(
        {
          error: `Failed to load story project: ${projectError?.message ?? "Unknown error"}`,
          fields: {
            projectId: fields.projectId,
            revisionInstructions: fields.revisionInstructions,
            versionId: fields.versionId,
          },
          intent: "revise-draft",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { data: versionRow, error: versionError } = await supabase
      .from("story_versions")
      .select(
        "id, version_number, model_name, content_markdown, prompt_snapshot, retrieval_snapshot, generation_metadata",
      )
      .eq("id", fields.versionId)
      .eq("story_project_id", fields.projectId)
      .single();

    if (versionError || !versionRow) {
      return data<ActionData>(
        {
          error: `Failed to load draft version: ${versionError?.message ?? "Unknown error"}`,
          fields: {
            projectId: fields.projectId,
            revisionInstructions: fields.revisionInstructions,
            versionId: fields.versionId,
          },
          intent: "revise-draft",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    try {
      await reviseStoryVersionFromProject({
        env,
        fears: await loadFearOptions(supabase),
        project: {
          id: projectRow.id,
          title: projectRow.title,
          slug: projectRow.slug,
          summary: projectRow.summary,
          seedPrompt: projectRow.seed_prompt,
          canonMode: projectRow.canon_mode,
          castPolicy: projectRow.cast_policy,
          selectedFearSlugs: projectRow.selected_fear_slugs ?? [],
          visibility: projectRow.visibility,
        },
        revisionInstructions: fields.revisionInstructions,
        storyVersion: {
          id: versionRow.id,
          versionNumber: versionRow.version_number,
          modelName: versionRow.model_name,
          contentMarkdown: versionRow.content_markdown,
          promptSnapshot: asRecord(versionRow.prompt_snapshot),
          retrievalSnapshot: Array.isArray(versionRow.retrieval_snapshot)
            ? versionRow.retrieval_snapshot
            : [],
          generationMetadata: asRecord(versionRow.generation_metadata),
        },
        supabase,
        viewerUserId: viewer.user.id,
      });
    } catch (error) {
      return data<ActionData>(
        {
          error: formatError(error),
          fields: {
            projectId: fields.projectId,
            revisionInstructions: fields.revisionInstructions,
            versionId: fields.versionId,
          },
          intent: "revise-draft",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    return redirect(`/workspace?project=${projectRow.slug}&revised=1#latest-draft`, {
      headers: responseHeaders,
    });
  }

  if (intent === "publish-version" || intent === "unpublish-version") {
    if (!fields.projectId || !fields.versionId) {
      return data<ActionData>(
        {
          error: "Missing story project or draft version.",
          fields: {
            projectId: fields.projectId,
            versionId: fields.versionId,
          },
          intent,
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { data: projectRow, error: projectError } = await supabase
      .from("story_projects")
      .select("id, slug, visibility")
      .eq("id", fields.projectId)
      .single();

    if (projectError || !projectRow) {
      return data<ActionData>(
        {
          error: `Failed to load story project: ${projectError?.message ?? "Unknown error"}`,
          fields: {
            projectId: fields.projectId,
            versionId: fields.versionId,
          },
          intent,
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { data: versionRow, error: versionError } = await supabase
      .from("story_versions")
      .select("id, version_number, published_at")
      .eq("id", fields.versionId)
      .eq("story_project_id", fields.projectId)
      .single();

    if (versionError || !versionRow) {
      return data<ActionData>(
        {
          error: `Failed to load story version: ${versionError?.message ?? "Unknown error"}`,
          fields: {
            projectId: fields.projectId,
            versionId: fields.versionId,
          },
          intent,
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    if (intent === "publish-version" && projectRow.visibility !== "public") {
      return data<ActionData>(
        {
          error: "Set the project visibility to public and save before publishing a story version.",
          fields: {
            projectId: fields.projectId,
            versionId: fields.versionId,
          },
          intent,
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const publishedAt = new Date().toISOString();

    if (intent === "publish-version") {
      const { error: clearPublishedError } = await supabase
        .from("story_versions")
        .update({ published_at: null })
        .eq("story_project_id", fields.projectId)
        .neq("id", fields.versionId);

      if (clearPublishedError) {
        return data<ActionData>(
          {
            error: `Failed to clear previous published version: ${clearPublishedError.message}`,
            fields: {
              projectId: fields.projectId,
              versionId: fields.versionId,
            },
            intent,
          },
          { headers: responseHeaders, status: 400 },
        );
      }

      const { error: publishVersionError } = await supabase
        .from("story_versions")
        .update({
          published_at: publishedAt,
          visibility: "public",
        })
        .eq("id", fields.versionId);

      if (publishVersionError) {
        return data<ActionData>(
          {
            error: `Failed to publish story version: ${publishVersionError.message}`,
            fields: {
              projectId: fields.projectId,
              versionId: fields.versionId,
            },
            intent,
          },
          { headers: responseHeaders, status: 400 },
        );
      }

      const { error: publishProjectError } = await supabase
        .from("story_projects")
        .update({
          published_at: publishedAt,
          status: "published",
        })
        .eq("id", fields.projectId);

      if (publishProjectError) {
        return data<ActionData>(
          {
            error: `Failed to publish story project: ${publishProjectError.message}`,
            fields: {
              projectId: fields.projectId,
              versionId: fields.versionId,
            },
            intent,
          },
          { headers: responseHeaders, status: 400 },
        );
      }

      return redirect(
        `/workspace?project=${projectRow.slug}&publishedVersion=${versionRow.version_number}#version-history`,
        { headers: responseHeaders },
      );
    }

    const { error: unpublishVersionError } = await supabase
      .from("story_versions")
      .update({
        published_at: null,
      })
      .eq("id", fields.versionId);

    if (unpublishVersionError) {
      return data<ActionData>(
        {
          error: `Failed to unpublish story version: ${unpublishVersionError.message}`,
          fields: {
            projectId: fields.projectId,
            versionId: fields.versionId,
          },
          intent,
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { error: unpublishProjectError } = await supabase
      .from("story_projects")
      .update({
        published_at: null,
        status: "draft",
      })
      .eq("id", fields.projectId);

    if (unpublishProjectError) {
      return data<ActionData>(
        {
          error: `Failed to update project publication state: ${unpublishProjectError.message}`,
          fields: {
            projectId: fields.projectId,
            versionId: fields.versionId,
          },
          intent,
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    return redirect(
      `/workspace?project=${projectRow.slug}&unpublishedVersion=${versionRow.version_number}#version-history`,
      { headers: responseHeaders },
    );
  }

  if (intent === "delete-draft") {
    if (!fields.projectId || !fields.versionId) {
      return data<ActionData>(
        {
          error: "Missing story project or draft version.",
          fields: {
            projectId: fields.projectId,
            versionId: fields.versionId,
          },
          intent: "delete-draft",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { data: versionRow, error: versionError } = await supabase
      .from("story_versions")
      .select("id, story_project_id, published_at, story_projects!inner(slug)")
      .eq("id", fields.versionId)
      .eq("story_project_id", fields.projectId)
      .single();

    if (versionError || !versionRow) {
      return data<ActionData>(
        {
          error: `Failed to load draft version: ${versionError?.message ?? "Unknown error"}`,
          fields: {
            projectId: fields.projectId,
            versionId: fields.versionId,
          },
          intent: "delete-draft",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { error: deleteError } = await supabase
      .from("story_versions")
      .delete()
      .eq("id", versionRow.id);

    if (deleteError) {
      return data<ActionData>(
        {
          error: `Failed to delete draft version: ${deleteError.message}`,
          fields: {
            projectId: fields.projectId,
            versionId: fields.versionId,
          },
          intent: "delete-draft",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const project = Array.isArray(versionRow.story_projects)
      ? versionRow.story_projects[0]
      : versionRow.story_projects;
    const projectSlug = project?.slug;

    if (versionRow.published_at) {
      const { error: resetProjectPublicationError } = await supabase
        .from("story_projects")
        .update({
          published_at: null,
          status: "draft",
        })
        .eq("id", fields.projectId);

      if (resetProjectPublicationError) {
        return data<ActionData>(
          {
            error: `Draft deleted, but failed to update project publication state: ${resetProjectPublicationError.message}`,
            fields: {
              projectId: fields.projectId,
              versionId: fields.versionId,
            },
            intent: "delete-draft",
          },
          { headers: responseHeaders, status: 400 },
        );
      }
    }

    if (!projectSlug) {
      return redirect("/workspace?deleted=1#story-versions", {
        headers: responseHeaders,
      });
    }

    return redirect(`/workspace?project=${projectSlug}&deleted=1#story-versions`, {
      headers: responseHeaders,
    });
  }

  if (intent === "delete-project") {
    if (!fields.projectId) {
      return data<ActionData>(
        {
          error: "Missing story project.",
          fields: {
            projectId: fields.projectId,
          },
          intent: "delete-project",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { data: projectRow, error: projectError } = await supabase
      .from("story_projects")
      .select("id")
      .eq("id", fields.projectId)
      .single();

    if (projectError || !projectRow) {
      return data<ActionData>(
        {
          error: `Failed to load story project: ${projectError?.message ?? "Unknown error"}`,
          fields: {
            projectId: fields.projectId,
          },
          intent: "delete-project",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    const { error: deleteError } = await supabase
      .from("story_projects")
      .delete()
      .eq("id", projectRow.id);

    if (deleteError) {
      return data<ActionData>(
        {
          error: `Failed to delete story project: ${deleteError.message}`,
          fields: {
            projectId: fields.projectId,
          },
          intent: "delete-project",
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    return redirect("/workspace?projectDeleted=1#project-list", {
      headers: responseHeaders,
    });
  }

  if (intent === "create-project" || intent === "update-project") {
    if (!fields.title) {
      return data<ActionData>(
        {
          error: "Title is required.",
          fields: {
            ...fields,
            selectedFearSlugs,
          },
          intent,
        },
        { headers: responseHeaders, status: 400 },
      );
    }

    if (
      !isAllowed(CANON_MODES, fields.canonMode) ||
      !isAllowed(CAST_POLICIES, fields.castPolicy)
    ) {
      return data<ActionData>(
        {
          error: "The selected canon or cast option is invalid.",
          fields: {
            ...fields,
            selectedFearSlugs,
          },
          intent,
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
          intent,
        },
        { headers: responseHeaders, status: 400 },
      );
    }
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
  const {
    fearOptions,
    flash,
    didDeleteProject,
    didDelete,
    didGenerate,
    didRevise,
    projects,
    retrieval,
    selectedProject,
    selectedPublishedVersion,
    selectedProjectVersions,
    selectedVersion,
    selectedVersionLinks,
    summary,
    viewer,
  } = loaderData;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const activeIntent = navigation.formData ? String(navigation.formData.get("intent") ?? "") : null;
  const isCreatingProject = isSubmitting && activeIntent === "create-project";
  const isSavingProject = isSubmitting && activeIntent === "update-project";
  const isGeneratingDraft = isSubmitting && activeIntent === "generate-draft";
  const isPublishingVersion = isSubmitting && activeIntent === "publish-version";
  const isRevisingDraft = isSubmitting && activeIntent === "revise-draft";
  const isDeletingProject = isSubmitting && activeIntent === "delete-project";
  const isUnpublishingVersion = isSubmitting && activeIntent === "unpublish-version";
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
  const revisionFields =
    actionData?.intent === "revise-draft"
      ? {
          revisionInstructions: actionData.fields.revisionInstructions ?? "",
        }
      : {
          revisionInstructions: "",
        };
  const selectedVersionUsage = selectedVersion
    ? readOpenAiUsage(selectedVersion.generationMetadata)
    : {
        completionTokens: null,
        promptTokens: null,
        totalTokens: null,
      };
  const selectedVersionSourceCount = selectedVersion?.retrievalSnapshot.length ?? 0;
  const versionNumberById = new Map(
    selectedProjectVersions.map((version) => [version.id, version.versionNumber]),
  );
  const selectedVersionParentNumber =
    selectedVersion?.parentVersionId && versionNumberById.has(selectedVersion.parentVersionId)
      ? versionNumberById.get(selectedVersion.parentVersionId) ?? null
      : null;
  const selectedVersionGenerationLabel = selectedVersion
    ? readGenerationLabel(selectedVersion.generationMetadata)
    : null;
  const selectedVersionIsPublished =
    selectedVersion !== null && selectedPublishedVersion?.id === selectedVersion.id;
  const currentPublicStoryPath =
    selectedProject && selectedPublishedVersion
      ? buildPublishedStoryPath(selectedProject.slug)
      : null;
  const currentPublicVersionPath =
    selectedProject && selectedPublishedVersion
      ? buildPublishedStoryVersionPath(selectedProject.slug, selectedPublishedVersion.versionNumber)
      : null;
  const versionPublicationReady = selectedProject?.visibility === "public";
  const historicalVersions =
    selectedVersion && selectedProjectVersions.length > 0
      ? selectedProjectVersions.slice(1)
      : selectedProjectVersions;
  const selectedDraft = selectedVersion ? splitDraftMarkdown(selectedVersion.contentMarkdown) : null;
  const selectedProjectIsPublished = selectedProject?.publishedAt !== null && selectedProject !== null;
  const activeDraftIsPublicVersion =
    selectedVersion !== null &&
    selectedPublishedVersion !== null &&
    selectedVersion.id === selectedPublishedVersion.id;

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1480px] px-6 py-10 lg:px-10">
      <div className="flex flex-col gap-4 rounded-[2rem] border border-stone-800/80 bg-stone-950/70 p-6 backdrop-blur lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-300">
            Creator Workspace
          </p>
          <h1 className="mt-4 font-display text-4xl text-stone-50">
            Shape the brief and generate archive-grounded drafts
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-300">
            Signed in as {viewer.profile?.displayName ?? viewer.user.displayName}. This route stores
            project-level canon controls, fear selection, and prompt seeds under your account, then
            turns them into immutable drafts with captured retrieval provenance.
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
          <span>{flash}</span>
          {(didGenerate || didRevise) && selectedVersion ? (
            <a
              href="#latest-draft"
              className="ml-3 font-semibold text-emerald-50 underline underline-offset-4"
            >
              Jump to latest draft
            </a>
          ) : null}
          {didDeleteProject ? (
            <a
              href="#project-list"
              className="ml-3 font-semibold text-emerald-50 underline underline-offset-4"
            >
              Back to projects
            </a>
          ) : null}
          {didDelete ? (
            <a
              href="#version-history"
              className="ml-3 font-semibold text-emerald-50 underline underline-offset-4"
            >
              Back to story versions
            </a>
          ) : null}
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

      {selectedProject && selectedVersion && selectedDraft ? (
        <section className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.18fr)_360px]">
          <article
            id="latest-draft"
            className="relative overflow-hidden rounded-[2rem] border border-stone-800/80 bg-stone-950/80 p-6"
          >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.16),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(14,165,233,0.12),transparent_38%)]" />
            <div className="relative">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.32em] text-amber-300">
                    Active Draft
                  </p>
                  <h2 className="mt-4 font-display text-5xl leading-tight text-stone-50">
                    {selectedDraft.title ?? selectedProject.title}
                  </h2>
                  <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-300">
                    This draft was generated from the source packet below and saved as version{" "}
                    {selectedVersion.versionNumber}. The preview and the generator use the same
                    retrieval query and packet, and that packet is persisted on the draft as its
                    retrieval snapshot.{" "}
                    {selectedVersionParentNumber
                      ? `It is a child revision of version ${selectedVersionParentNumber}.`
                      : "It is currently the root draft in this project chain."}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.22em]">
                    <span className="rounded-full border border-stone-700 px-3 py-1 text-stone-300">
                      workspace latest
                    </span>
                    {selectedVersionIsPublished ? (
                      <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-3 py-1 text-emerald-100">
                        live public version
                      </span>
                    ) : selectedPublishedVersion ? (
                      <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-3 py-1 text-amber-100">
                        public route still serves v{selectedPublishedVersion.versionNumber}
                      </span>
                    ) : (
                      <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-sky-100">
                        not published yet
                      </span>
                    )}
                  </div>
                </div>

                <div className="rounded-[1.5rem] border border-stone-800 bg-stone-900/80 p-4 text-sm text-stone-300">
                  <p>
                    <span className="text-stone-500">Version:</span>{" "}
                    {selectedVersion.versionNumber}
                  </p>
                  <p className="mt-2">
                    <span className="text-stone-500">Model:</span>{" "}
                    {selectedVersion.modelName ?? "Unknown"}
                  </p>
                  <p className="mt-2">
                    <span className="text-stone-500">Created:</span>{" "}
                    {formatDate(selectedVersion.createdAt)}
                  </p>
                  {selectedVersionGenerationLabel ? (
                    <p className="mt-2">
                      <span className="text-stone-500">Mode:</span>{" "}
                      {selectedVersionGenerationLabel}
                    </p>
                  ) : null}
                </div>
              </div>

              {selectedVersionParentNumber && selectedVersion.revisionNotes ? (
                <div className="mt-6 rounded-[1.5rem] border border-stone-800 bg-stone-900/75 p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.28em] text-amber-300">
                    Revision brief
                  </p>
                  <p className="mt-3 text-sm leading-7 text-stone-300">
                    Generated as version {selectedVersion.versionNumber} from version{" "}
                    {selectedVersionParentNumber}. These instructions were applied to create the
                    current draft:
                  </p>
                  <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-stone-100">
                    {selectedVersion.revisionNotes}
                  </p>
                </div>
              ) : null}

              <pre className="mt-8 max-h-[980px] overflow-auto whitespace-pre-wrap rounded-[1.6rem] border border-stone-800 bg-stone-950/90 p-6 text-[15px] leading-8 text-stone-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                {selectedDraft.body}
              </pre>
            </div>
          </article>

          <aside className="space-y-6">
            <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                Draft Context
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <DraftContextStat
                  label="Packet chunks"
                  value={formatNumber(selectedVersionSourceCount)}
                />
                <DraftContextStat
                  label="Linked episodes"
                  value={formatNumber(selectedVersionLinks.length)}
                />
                <DraftContextStat
                  label="Lineage"
                  value={
                    selectedVersionParentNumber
                      ? `v${selectedVersionParentNumber} -> v${selectedVersion.versionNumber}`
                      : "root"
                  }
                />
                <DraftContextStat
                  label="Prompt tokens"
                  value={formatMetricNumber(selectedVersionUsage.promptTokens)}
                />
                <DraftContextStat
                  label="Completion tokens"
                  value={formatMetricNumber(selectedVersionUsage.completionTokens)}
                />
                <DraftContextStat
                  label="Total tokens"
                  value={formatMetricNumber(selectedVersionUsage.totalTokens)}
                />
              </div>

              <article className="mt-5 rounded-[1.4rem] border border-stone-800 bg-stone-900/70 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">
                  Publication
                </p>
                <p className="mt-3 text-sm leading-7 text-stone-300">
                  {selectedVersionIsPublished
                    ? `Version ${selectedVersion.versionNumber} is the live public story.`
                    : selectedPublishedVersion
                      ? `Version ${selectedPublishedVersion.versionNumber} is currently public. Publish this draft when you want the archive feed and canonical reader URL to switch.`
                      : "No version is public yet. Publishing creates the public archive entry and stable reader routes."}
                </p>

                {currentPublicStoryPath && currentPublicVersionPath ? (
                  <div className="mt-4 grid gap-3">
                    <Link
                      to={currentPublicStoryPath}
                      className="rounded-[1.2rem] border border-emerald-500/35 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100 transition hover:border-emerald-300/55 hover:bg-emerald-500/20"
                    >
                      Open canonical public story
                    </Link>
                    <Link
                      to={currentPublicVersionPath}
                      className="rounded-[1.2rem] border border-stone-800 bg-stone-950/80 px-4 py-3 text-sm text-stone-200 transition hover:border-stone-600"
                    >
                      Open version route
                    </Link>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-3">
                  {selectedVersionIsPublished ? (
                    <UnpublishVersionButton
                      isSubmitting={isSubmitting}
                      isUnpublishing={isUnpublishingVersion}
                      projectId={selectedProject.id}
                      versionId={selectedVersion.id}
                      versionNumber={selectedVersion.versionNumber}
                    />
                  ) : (
                    <PublishVersionButton
                      disabledReason={
                        versionPublicationReady
                          ? null
                          : "Set project visibility to public and save before publishing."
                      }
                      isSubmitting={isSubmitting}
                      isPublishing={isPublishingVersion}
                      projectId={selectedProject.id}
                      versionId={selectedVersion.id}
                      versionNumber={selectedVersion.versionNumber}
                    />
                  )}
                </div>
              </article>

              <div className="mt-5 grid gap-3">
                <a
                  href="#source-packet"
                  className="rounded-[1.2rem] border border-stone-800 bg-stone-900/80 px-4 py-3 text-sm text-stone-200 transition hover:border-stone-600"
                >
                  Source packet preview
                </a>
                <a
                  href="#project-brief"
                  className="rounded-[1.2rem] border border-stone-800 bg-stone-900/80 px-4 py-3 text-sm text-stone-200 transition hover:border-stone-600"
                >
                  Brief controls
                </a>
                <a
                  href="#version-history"
                  className="rounded-[1.2rem] border border-stone-800 bg-stone-900/80 px-4 py-3 text-sm text-stone-200 transition hover:border-stone-600"
                >
                  Version history
                </a>
              </div>

              <article className="mt-5 rounded-[1.4rem] border border-stone-800 bg-stone-900/70 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">
                  Revise Draft
                </p>
                <p className="mt-3 text-sm leading-7 text-stone-300">
                  Write concrete edit instructions. This creates a new immutable child version from
                  v{selectedVersion.versionNumber} and reuses the saved source packet on this draft
                  instead of rerunning retrieval.
                </p>

                <Form method="post" className="mt-4 space-y-4">
                  <input type="hidden" name="intent" value="revise-draft" />
                  <input type="hidden" name="projectId" value={selectedProject.id} />
                  <input type="hidden" name="versionId" value={selectedVersion.id} />
                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
                      Revision instructions
                    </span>
                    <textarea
                      name="revisionInstructions"
                      rows={6}
                      defaultValue={revisionFields.revisionInstructions}
                      placeholder="Make the opening quieter, remove canon character cameos, and end on a sharper Lonely turn."
                      className="mt-2 w-full rounded-[1.2rem] border border-stone-700 bg-stone-950 px-4 py-3 text-sm leading-7 text-stone-100 outline-none transition placeholder:text-stone-500 focus:border-amber-400/60"
                    />
                  </label>

                  <button
                    type="submit"
                    disabled={isRevisingDraft || isGeneratingDraft || isSavingProject || isCreatingProject}
                    className="w-full rounded-full border border-sky-500/35 bg-sky-500/10 px-4 py-3 text-xs font-semibold uppercase tracking-[0.22em] text-sky-100 transition hover:border-sky-300/55 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isRevisingDraft
                      ? "Generating revision..."
                      : `Revise from v${selectedVersion.versionNumber}`}
                  </button>
                </Form>
              </article>

              <div className="mt-5 flex justify-end">
                <DeleteDraftButton
                  isSubmitting={isSubmitting}
                  projectId={selectedProject.id}
                  versionId={selectedVersion.id}
                  versionNumber={selectedVersion.versionNumber}
                />
              </div>
            </article>

            <article className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                Archive Material Used
              </p>
              <p className="mt-3 text-sm leading-7 text-stone-300">
                These episode links were written when the draft was saved. They come from the same
                retrieval packet used during generation.
              </p>

              {selectedVersionLinks.length > 0 ? (
                <div className="mt-4 grid gap-3">
                  {selectedVersionLinks.map((link) => (
                    <article
                      key={link.episodeId}
                      className="rounded-[1.2rem] border border-stone-800 bg-stone-900/80 p-4"
                    >
                      <p className="text-xs uppercase tracking-[0.24em] text-stone-500">
                        MAG {String(link.episodeNumber).padStart(3, "0")}
                      </p>
                      <h3 className="mt-2 font-display text-2xl text-stone-50">
                        {link.episodeTitle}
                      </h3>
                      <p className="mt-3 text-sm text-stone-300">
                        {formatNumber(link.chunkIds.length)} chunks ·{" "}
                        {link.relevanceScore !== null
                          ? `relevance ${link.relevanceScore.toFixed(3)}`
                          : "not scored"}
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm leading-7 text-stone-400">
                  No persisted provenance links were found for this draft.
                </p>
              )}
            </article>
          </aside>
        </section>
      ) : null}

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
                {isCreatingProject ? "Saving..." : "Create brief"}
              </button>
            </Form>
          </article>

          <article
            id="project-list"
            className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-4"
          >
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
                        {project.publishedAt ? (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-emerald-100">
                            published
                          </span>
                        ) : null}
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
              <article
                id="project-brief"
                className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                      Selected brief
                    </p>
                    <h2 className="mt-4 font-display text-5xl text-stone-50">
                      {selectedProject.title}
                    </h2>
                    <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-300">
                      This is the durable project shell for retrieval and generation. The fields below
                      become the starting brief, and the retrieval preview lets you tune the
                      constraints before generating a new immutable version.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.22em]">
                      <span className="rounded-full border border-stone-700 px-3 py-1 text-stone-300">
                        {selectedProject.visibility}
                      </span>
                      <span className="rounded-full border border-stone-700 px-3 py-1 text-stone-300">
                        {selectedProject.status}
                      </span>
                      {selectedProjectIsPublished ? (
                        <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-3 py-1 text-emerald-100">
                          public story live
                        </span>
                      ) : null}
                    </div>
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
                    {selectedProject.publishedAt ? (
                      <p className="mt-2">
                        <span className="text-stone-500">Published:</span>{" "}
                        {formatDate(selectedProject.publishedAt)}
                      </p>
                    ) : null}
                  </div>
                </div>

                {selectedPublishedVersion ? (
                  <div className="mt-6 rounded-[1.5rem] border border-emerald-500/25 bg-emerald-500/10 p-5 text-sm text-emerald-50/90">
                    <p className="text-xs font-semibold uppercase tracking-[0.28em] text-emerald-200">
                      Public story routing
                    </p>
                    <p className="mt-3 leading-7">
                      The archive feed and canonical story route currently point at version{" "}
                      {selectedPublishedVersion.versionNumber}. Publishing a different version will
                      move the canonical route while keeping version-specific links stable.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-3">
                      {currentPublicStoryPath ? (
                        <Link
                          to={currentPublicStoryPath}
                          className="rounded-full border border-emerald-300/35 bg-emerald-500/15 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-50 transition hover:border-emerald-200/55 hover:bg-emerald-500/25"
                        >
                          Open canonical route
                        </Link>
                      ) : null}
                      {currentPublicVersionPath ? (
                        <Link
                          to={currentPublicVersionPath}
                          className="rounded-full border border-stone-700 bg-stone-950/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-100 transition hover:border-stone-500"
                        >
                          Open public version route
                        </Link>
                      ) : null}
                    </div>
                  </div>
                ) : null}

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

                  <p className="text-sm leading-7 text-stone-400">
                    Strict keeps canon facts intact. Adjacent stays canon-compatible while exploring
                    new corners. AU means Alternate Universe: the setting, roles, or timeline can
                    change deliberately as long as the fear logic and internal consistency still hold.
                  </p>

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
                    {isSavingProject ? "Saving..." : "Save brief"}
                  </button>
                </Form>

                <Form method="post" className="mt-5">
                  <input type="hidden" name="intent" value="generate-draft" />
                  <input type="hidden" name="projectId" value={selectedProject.id} />
                  <button
                    type="submit"
                    disabled={isSubmitting || !buildStoryRetrievalQuery(selectedProject)}
                    className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-5 py-3 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-100 transition hover:border-emerald-300/55 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isGeneratingDraft ? "Generating..." : "Generate draft version"}
                  </button>
                </Form>

                <div className="mt-5 flex justify-end">
                  <DeleteProjectButton
                    isSubmitting={isSubmitting || isDeletingProject}
                    projectId={selectedProject.id}
                    projectTitle={selectedProject.title}
                    versionCount={selectedProject.versionCount}
                  />
                </div>
              </article>

              <article
                id="source-packet"
                className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                      Retrieval preview
                    </p>
                    <h3 className="mt-3 font-display text-3xl text-stone-50">
                      Source packet preview for this brief
                    </h3>
                    <p className="mt-3 max-w-3xl text-sm leading-7 text-stone-300">
                      This packet is not a separate preview-only artifact. The generator uses this
                      retrieval query and source packet directly, then stores the resulting packet on
                      each draft as `retrieval_snapshot`.
                    </p>
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
                    preview will show the chunks most likely to ground the next draft.
                  </p>
                )}
              </article>

              <article
                id="version-history"
                className="rounded-[2rem] border border-stone-800/80 bg-stone-950/75 p-6"
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-stone-500">
                      Version history
                    </p>
                    <h3 className="mt-3 font-display text-3xl text-stone-50">
                      Older snapshots stay here
                    </h3>
                    <p className="mt-3 text-sm leading-7 text-stone-300">
                      The active draft is surfaced above. This section keeps the rest of the immutable
                      version chain available for rollback and comparison.
                    </p>
                  </div>
                  <span className="rounded-full border border-stone-700 px-3 py-1 text-xs uppercase tracking-[0.22em] text-stone-300">
                    {selectedProjectVersions.length} versions
                  </span>
                </div>

                {historicalVersions.length > 0 ? (
                  <div className="mt-6 space-y-6">
                    <div className="grid gap-3">
                      {historicalVersions.map((version) => {
                        const parentVersionNumber =
                          version.parentVersionId && versionNumberById.has(version.parentVersionId)
                            ? versionNumberById.get(version.parentVersionId) ?? null
                            : null;
                        const generationLabel = readGenerationLabel(version.generationMetadata);

                        return (
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
                          <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.2em] text-stone-400">
                                <span className="rounded-full border border-stone-700 px-2 py-1">
                                  {parentVersionNumber
                                    ? `child of v${parentVersionNumber}`
                                    : "root version"}
                                </span>
                                {version.publishedAt ? (
                                  <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-1 text-emerald-100">
                                    live public version
                                  </span>
                                ) : null}
                                {generationLabel ? (
                                  <span className="rounded-full border border-stone-700 px-2 py-1">
                                    {generationLabel}
                                  </span>
                                ) : null}
                              </div>
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
                              {version.publishedAt ? (
                                <p className="mt-2">
                                  <span className="text-stone-500">Published:</span>{" "}
                                  {formatDate(version.publishedAt)}
                                </p>
                              ) : null}
                            </div>
                          </div>

                          <div className="mt-4 flex flex-wrap justify-end gap-3">
                            {version.publishedAt ? (
                              <>
                                {selectedProject ? (
                                  <Link
                                    to={buildPublishedStoryPath(selectedProject.slug)}
                                    className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-100 transition hover:border-emerald-300/55 hover:bg-emerald-500/20"
                                  >
                                    Open story
                                  </Link>
                                ) : null}
                                <UnpublishVersionButton
                                  isSubmitting={isSubmitting}
                                  isUnpublishing={isUnpublishingVersion}
                                  projectId={selectedProject.id}
                                  versionId={version.id}
                                  versionNumber={version.versionNumber}
                                />
                              </>
                            ) : (
                              <PublishVersionButton
                                disabledReason={
                                  versionPublicationReady
                                    ? null
                                    : "Set project visibility to public and save before publishing."
                                }
                                isSubmitting={isSubmitting}
                                isPublishing={isPublishingVersion}
                                projectId={selectedProject.id}
                                versionId={version.id}
                                versionNumber={version.versionNumber}
                              />
                            )}
                            <DeleteDraftButton
                              isSubmitting={isSubmitting}
                              projectId={selectedProject.id}
                              versionId={version.id}
                              versionNumber={version.versionNumber}
                            />
                          </div>

                          {version.revisionNotes ? (
                            <p className="mt-4 text-sm leading-6 text-stone-300">
                              {version.revisionNotes}
                            </p>
                          ) : null}
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="mt-6 text-sm leading-7 text-stone-400">
                    {selectedVersion
                      ? "No earlier drafts yet. Generate again when you want a second immutable version in the chain."
                      : "No draft exists yet. Generate the first immutable story version to capture the prompt snapshot, retrieval packet, and source links."}
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

function DraftContextStat({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-[1.2rem] border border-stone-800 bg-stone-900/80 p-4">
      <p className="text-[11px] uppercase tracking-[0.24em] text-stone-500">{label}</p>
      <p className="mt-3 font-display text-3xl text-stone-50">{value}</p>
    </article>
  );
}

function PublishVersionButton({
  disabledReason,
  isPublishing,
  isSubmitting,
  projectId,
  versionId,
  versionNumber,
}: {
  disabledReason: string | null;
  isPublishing: boolean;
  isSubmitting: boolean;
  projectId: string;
  versionId: string;
  versionNumber: number;
}) {
  const disabled = isSubmitting || disabledReason !== null;

  return (
    <Form method="post" title={disabledReason ?? undefined}>
      <input type="hidden" name="intent" value="publish-version" />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="versionId" value={versionId} />
      <button
        type="submit"
        disabled={disabled}
        className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-100 transition hover:border-emerald-300/55 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPublishing ? `Publishing v${versionNumber}...` : `Publish v${versionNumber}`}
      </button>
    </Form>
  );
}

function UnpublishVersionButton({
  isUnpublishing,
  isSubmitting,
  projectId,
  versionId,
  versionNumber,
}: {
  isUnpublishing: boolean;
  isSubmitting: boolean;
  projectId: string;
  versionId: string;
  versionNumber: number;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="unpublish-version" />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="versionId" value={versionId} />
      <button
        type="submit"
        disabled={isSubmitting}
        onClick={(event) => {
          if (
            !window.confirm(
              `Unpublish version ${versionNumber}? It will disappear from the public archive and story routes until another version is published.`,
            )
          ) {
            event.preventDefault();
          }
        }}
        className="rounded-full border border-stone-700 bg-stone-900/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-100 transition hover:border-stone-500 hover:bg-stone-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isUnpublishing ? `Unpublishing v${versionNumber}...` : "Unpublish"}
      </button>
    </Form>
  );
}

function DeleteDraftButton({
  isSubmitting,
  projectId,
  versionId,
  versionNumber,
}: {
  isSubmitting: boolean;
  projectId: string;
  versionId: string;
  versionNumber: number;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="delete-draft" />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="versionId" value={versionId} />
      <button
        type="submit"
        disabled={isSubmitting}
        onClick={(event) => {
          if (
            !window.confirm(
              `Delete draft version ${versionNumber}? This removes the saved draft and its provenance links.`,
            )
          ) {
            event.preventDefault();
          }
        }}
        className="rounded-full border border-red-500/35 bg-red-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-red-100 transition hover:border-red-400/55 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Delete draft
      </button>
    </Form>
  );
}

function DeleteProjectButton({
  isSubmitting,
  projectId,
  projectTitle,
  versionCount,
}: {
  isSubmitting: boolean;
  projectId: string;
  projectTitle: string;
  versionCount: number;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="delete-project" />
      <input type="hidden" name="projectId" value={projectId} />
      <button
        type="submit"
        disabled={isSubmitting}
        onClick={(event) => {
          const draftLabel = versionCount === 1 ? "1 draft" : `${versionCount} drafts`;

          if (
            !window.confirm(
              `Delete project "${projectTitle}"? This removes the brief, ${draftLabel}, and all saved provenance under it.`,
            )
          ) {
            event.preventDefault();
          }
        }}
        className="rounded-full border border-red-500/35 bg-red-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-red-100 transition hover:border-red-400/55 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Delete project
      </button>
    </Form>
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

async function loadFearSlugSet(
  supabase: Awaited<ReturnType<typeof getViewer>>["supabase"],
) {
  const { data, error } = await supabase.from("fears").select("slug");

  if (error) {
    throw new Error(`Failed to validate fear selection: ${error.message}`);
  }

  return new Set((data ?? []).map((row) => row.slug));
}

async function loadFearOptions(
  supabase: Awaited<ReturnType<typeof getViewer>>["supabase"],
) {
  const { data, error } = await supabase
    .from("fears")
    .select("slug, name, description")
    .order("sort_order", { ascending: true });

  if (error) {
    throw new Error(`Failed to load fear taxonomy: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
  }));
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

function formatMetricNumber(value: number | null) {
  if (value === null) {
    return "n/a";
  }

  return formatNumber(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readOpenAiUsage(metadata: Record<string, unknown>) {
  const usage = asRecord(metadata.openai_usage);

  return {
    completionTokens: readOptionalNumber(usage.completion_tokens),
    promptTokens: readOptionalNumber(usage.prompt_tokens),
    totalTokens: readOptionalNumber(usage.total_tokens),
  };
}

function readGenerationLabel(metadata: Record<string, unknown>) {
  const mode = metadata.generation_mode;

  if (mode === "revision") {
    return "revision";
  }

  if (mode === "brief-generation") {
    return "brief generation";
  }

  return null;
}

function readOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  return null;
}

function splitDraftMarkdown(markdown: string) {
  const normalized = markdown.trim();
  const [firstLine, ...rest] = normalized.split("\n");

  if (firstLine?.startsWith("# ")) {
    return {
      body: rest.join("\n").trim(),
      title: firstLine.slice(2).trim(),
    };
  }

  return {
    body: normalized,
    title: null,
  };
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
