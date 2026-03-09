export type PublishedStorySummary = {
  canonMode: "strict" | "adjacent" | "au";
  castPolicy: "none" | "cameo" | "full";
  excerpt: string;
  projectSlug: string;
  projectSummary: string | null;
  publishedAt: string;
  selectedFearSlugs: string[];
  title: string;
  versionNumber: number;
};

export type PublishedStoryDetail = PublishedStorySummary & {
  contentMarkdown: string;
  createdAt: string;
  projectTitle: string;
  revisionNotes: string | null;
};

export function buildPublishedStoryPath(projectSlug: string) {
  return `/stories/${encodeURIComponent(projectSlug)}`;
}

export function buildPublishedStoryVersionPath(projectSlug: string, versionNumber: number) {
  return `/stories/${encodeURIComponent(projectSlug)}/v/${versionNumber}`;
}
