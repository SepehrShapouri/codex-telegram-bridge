export function chunkText(input: string, limit: number): string[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return ["(empty response)"];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const splitAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const index = splitAt > limit * 0.4 ? splitAt : limit;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

export function truncateText(input: string, limit: number): string {
  if (input.length <= limit) {
    return input;
  }
  return `${input.slice(0, Math.max(0, limit - 18))}\n\n[truncated output]`;
}

export function sanitizeFileName(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "artifact.txt";
}
