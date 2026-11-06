/** Whole-block excerpt for a reading preview. Never slice through source syntax. */
export function documentExcerpt(source: string | null, limit: number): { text: string | null; truncated: boolean } {
  if (!source) return { text: null, truncated: false };
  const text = source.replace(/\r\n?/g, '\n');
  if (text.length <= limit) return { text, truncated: false };
  let offset = 0, boundary = 0;
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const marker = line.trim().match(/^(`{3,}|~{3,})(.*)$/);
    if (marker && !fence) fence = marker[1]!;
    else if (marker && fence && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
    offset += line.length + 1;
    if (offset > limit) break;
    if (!line.trim() && !fence) boundary = offset;
  }
  return { text: boundary ? text.slice(0, boundary).trimEnd() : null, truncated: true };
}
