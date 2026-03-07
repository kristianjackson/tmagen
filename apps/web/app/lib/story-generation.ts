export function buildStoryRetrievalQuery(project: {
  title: string;
  summary: string | null;
  seedPrompt: string | null;
}) {
  const prompt = normalizeOptionalString(project.seedPrompt);

  if (prompt) {
    return prompt;
  }

  const summary = normalizeOptionalString(project.summary);
  return [project.title.trim(), summary].filter(Boolean).join(". ");
}

function normalizeOptionalString(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
