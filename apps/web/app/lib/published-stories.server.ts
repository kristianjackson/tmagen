import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublishedStoryDetail, PublishedStorySummary } from "./published-stories";

const PUBLIC_STORY_SELECT = `
  id,
  version_number,
  published_at,
  created_at,
  revision_notes,
  content_markdown,
  story_projects!inner(
    title,
    slug,
    summary,
    canon_mode,
    cast_policy,
    selected_fear_slugs,
    visibility
  )
`;

export async function listPublishedStorySummaries(
  adminClient: SupabaseClient,
  limit = 6,
): Promise<PublishedStorySummary[]> {
  const { data, error } = await adminClient
    .from("story_versions")
    .select(PUBLIC_STORY_SELECT)
    .eq("visibility", "public")
    .not("published_at", "is", null)
    .eq("story_projects.visibility", "public")
    .order("published_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load published stories: ${error.message}`);
  }

  return (data ?? [])
    .map(normalizePublishedStoryRow)
    .filter((story): story is PublishedStoryDetail => story !== null)
    .map((story) => ({
      canonMode: story.canonMode,
      castPolicy: story.castPolicy,
      excerpt: story.excerpt,
      projectSlug: story.projectSlug,
      projectSummary: story.projectSummary,
      publishedAt: story.publishedAt,
      selectedFearSlugs: story.selectedFearSlugs,
      title: story.title,
      versionNumber: story.versionNumber,
    }));
}

export async function loadPublishedStory({
  adminClient,
  storySlug,
  versionNumber,
}: {
  adminClient: SupabaseClient;
  storySlug: string;
  versionNumber?: number | null;
}): Promise<PublishedStoryDetail | null> {
  let query = adminClient
    .from("story_versions")
    .select(PUBLIC_STORY_SELECT)
    .eq("visibility", "public")
    .not("published_at", "is", null)
    .eq("story_projects.slug", storySlug)
    .eq("story_projects.visibility", "public");

  if (typeof versionNumber === "number") {
    query = query.eq("version_number", versionNumber);
  } else {
    query = query.order("published_at", { ascending: false }).limit(1);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(`Failed to load published story: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return normalizePublishedStoryRow(data);
}

function normalizePublishedStoryRow(value: unknown): PublishedStoryDetail | null {
  const record = asRecord(value);
  const projectValue = record.story_projects;
  const projectRecord = asRecord(Array.isArray(projectValue) ? projectValue[0] : projectValue);
  const projectSlug = readOptionalString(projectRecord.slug);
  const projectTitle = readOptionalString(projectRecord.title);
  const publishedAt = readOptionalString(record.published_at);
  const contentMarkdown = readOptionalString(record.content_markdown);

  if (!projectSlug || !projectTitle || !publishedAt || !contentMarkdown) {
    return null;
  }

  const split = splitStoryMarkdown(contentMarkdown);
  const title = split.title ?? projectTitle;

  return {
    canonMode: readCanonMode(projectRecord.canon_mode),
    castPolicy: readCastPolicy(projectRecord.cast_policy),
    contentMarkdown,
    createdAt: readOptionalString(record.created_at) ?? publishedAt,
    excerpt: buildStoryExcerpt(split.body, readOptionalString(projectRecord.summary)),
    projectSlug,
    projectSummary: readOptionalString(projectRecord.summary),
    projectTitle,
    publishedAt,
    revisionNotes: readOptionalString(record.revision_notes),
    selectedFearSlugs: readStringArray(projectRecord.selected_fear_slugs),
    title,
    versionNumber: readInteger(record.version_number),
  };
}

function splitStoryMarkdown(markdown: string) {
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

function buildStoryExcerpt(body: string, fallbackSummary: string | null, maxLength = 220) {
  if (fallbackSummary) {
    return fallbackSummary;
  }

  const normalized = body.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function readCanonMode(value: unknown): PublishedStorySummary["canonMode"] {
  return value === "strict" || value === "au" ? value : "adjacent";
}

function readCastPolicy(value: unknown): PublishedStorySummary["castPolicy"] {
  return value === "none" || value === "full" ? value : "cameo";
}

function readOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  return 0;
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}
