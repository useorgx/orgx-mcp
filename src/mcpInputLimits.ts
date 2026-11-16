/** Bound validation work before Zod walks or formats errors for tool arguments. */
export const MAX_TOOL_INPUT_ELEMENTS = 10_000;

// Matches the published hierarchy-batch and broker request ceiling. The
// agents transport adapter does not expose the SDK's maxRequestBodySize.
export const MAX_MCP_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
export const MCP_REQUEST_BODY_TIMEOUT_MS = 8_000;

function bodyError(status: number, message: string): Response {
  return Response.json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message },
  }, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

/** Enforce actual streamed bytes before any transport JSON parsing. */
export async function boundMcpRequestBody(
  request: Request,
  maxBytes = MAX_MCP_REQUEST_BODY_BYTES,
  timeoutMs = MCP_REQUEST_BODY_TIMEOUT_MS
): Promise<{ request: Request; response?: Response }> {
  if (!request.body) return { request };
  const tooLarge = () => bodyError(413, `MCP request body exceeds the ${maxBytes} byte limit.`);
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    void request.body.cancel().catch(() => {});
    return { request, response: tooLarge() };
  }

  const reader = request.body.getReader();
  // Do not retain one object per incoming chunk: a small valid body can be
  // split into millions of tiny chunks. Storage grows only to the byte cap.
  let body = new Uint8Array(Math.min(16 * 1024, maxBytes));
  let size = 0;
  let failure: 'timeout' | 'cancelled' | undefined;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => {});
  };
  let rejectRead: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  // An already-aborted caller or an elapsed-time check can stop before the
  // first read races this promise. Keep that rejection observed as well.
  void stopped.catch(() => {});
  const stop = (reason: 'timeout' | 'cancelled') => {
    if (failure) return;
    failure = reason;
    cancel();
    rejectRead(new Error('MCP request body read stopped'));
  };
  const expiresAt = performance.now() + timeoutMs;
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const onAbort = () => stop('cancelled');
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  const checkDeadline = () => {
    // A sequence of immediately fulfilled tiny chunks can starve timer
    // callbacks. Check a monotonic deadline around every read too.
    if (!failure && performance.now() >= expiresAt) stop('timeout');
    if (failure) throw new Error('MCP request body read stopped');
  };
  const consume = async (): Promise<Response | undefined> => {
    while (true) {
      checkDeadline();
      const { done, value } = await reader.read();
      checkDeadline();
      if (done) break;
      const nextSize = size + value.byteLength;
      if (nextSize > maxBytes) {
        cancel();
        return tooLarge();
      }
      if (nextSize > body.length) {
        const capacity = Math.min(maxBytes, Math.max(nextSize, body.length * 2));
        const grown = new Uint8Array(capacity);
        grown.set(body.subarray(0, size));
        body = grown;
      }
      body.set(value, size);
      size = nextSize;
    }
    return undefined;
  };
  try {
    // One race for the entire read also avoids accumulating a stop-promise
    // reaction per tiny chunk while the cancellation promise stays pending.
    const response = await Promise.race([consume(), stopped]);
    if (response) return { request, response };
  } catch {
    cancel();
    if (failure === 'timeout') {
      return { request, response: bodyError(408, 'MCP request body reading timed out.') };
    }
    if (failure === 'cancelled') {
      return { request, response: bodyError(400, 'MCP request body reading was cancelled.') };
    }
    return { request, response: bodyError(400, 'Unable to read the MCP request body.') };
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* Do not wait for a stalled cancellation. */ }
  }

  const headers = new Headers(request.headers);
  headers.set('content-length', String(size));
  return { request: new Request(request, { headers, body: body.subarray(0, size) }) };
}
