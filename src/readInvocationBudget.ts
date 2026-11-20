import { AsyncLocalStorage } from 'node:async_hooks';

export const READ_INVOCATION_TIMEOUT_MS = 10_000;

// These reads meter allowance, so their truthful MCP annotation is not
// readOnlyHint. Metering does not make them long-running work commands.
const METERED_READ_TOOLS = new Set([
  'orgx_search', 'orgx_get_next_actions', 'orgx_get_agent_status',
  'orgx_get_initiative_progress',
]);

type ReadInvocationBudget = { deadline: number; signal: AbortSignal };
const invocations = new AsyncLocalStorage<ReadInvocationBudget>();

export function currentReadInvocationBudget(): ReadInvocationBudget | undefined {
  return invocations.getStore();
}

export class ReadInvocationDeadlineError extends Error {
  constructor(readonly kind: 'timeout' | 'cancelled') {
    super(kind === 'timeout'
      ? 'The OrgX read took too long. Please try again.'
      : 'The OrgX read was cancelled.');
    this.name = 'ReadInvocationDeadlineError';
  }
}

/** One budget covers every API read and optional enrichment in a tool call. */
export function withReadInvocationBudget<T>(
  toolName: string,
  config: Record<string, unknown>,
  extra: unknown,
  run: () => T
): T | Promise<T> {
  const inherited = invocations.getStore();
  if (inherited) {
    if (inherited.signal.aborted) throw inherited.signal.reason;
    return run();
  }
  const annotations = config.annotations as { readOnlyHint?: unknown } | undefined;
  if (annotations?.readOnlyHint !== true && !METERED_READ_TOOLS.has(toolName)) return run();

  const controller = new AbortController();
  const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
  const deadline = performance.now() + READ_INVOCATION_TIMEOUT_MS;
  return invocations.run({ deadline, signal: controller.signal }, async () => {
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      onAbort = () => controller.abort(new ReadInvocationDeadlineError('cancelled'));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(new ReadInvocationDeadlineError('timeout')), READ_INVOCATION_TIMEOUT_MS);
    });
    try {
      const work = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return run();
      });
      return await Promise.race([work, cancelled]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      // Detached continuations retain AsyncLocalStorage. Closing the scope
      // must also prevent those continuations from starting another request.
      controller.abort(new ReadInvocationDeadlineError('cancelled'));
    }
  });
}
