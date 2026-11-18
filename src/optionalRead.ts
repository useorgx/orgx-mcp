/** Optional projections must not consume the parent tool's full API timeout. */
export const OPTIONAL_READ_TIMEOUT_MS = 4_000;

/** Bound the whole read, including response bodies and retries, and cancel I/O. */
export async function withOptionalReadDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  timeoutMs = OPTIONAL_READ_TIMEOUT_MS
): Promise<T | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort('optional read deadline exceeded');
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([read(controller.signal), expired]);
  } catch {
    controller.abort('optional read failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
