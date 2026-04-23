const encoder = new TextEncoder();

/**
 * Best-effort constant-time comparison for Worker-managed shared secrets.
 */
export function secureCompare(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLength = Math.max(aBytes.length, bBytes.length);

  let mismatch = aBytes.length === bBytes.length ? 0 : 1;
  for (let i = 0; i < maxLength; i += 1) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }

  return mismatch === 0;
}
