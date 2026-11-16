/** Bounded broker control-plane reads; streamed vendor tool results stay streamed. */
export class BrokerIoError extends Error {
  constructor(readonly code: 'payload_too_large' | 'body_timeout') {
    super(code);
  }
}

export function createBrokerIoBudget(timeoutMs: number) {
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      reject(new BrokerIoError('body_timeout'));
    }, timeoutMs);
  });
  const check = () => {
    // A client can queue tiny chunks without yielding to the timer task.
    if (expired || performance.now() >= expiresAt) {
      expired = true;
      controller.abort();
      throw new BrokerIoError('body_timeout');
    }
  };
  return {
    signal: controller.signal,
    check,
    run<T>(operation: () => Promise<T>): Promise<T> {
      try {
        check();
        return Promise.race([operation(), deadline]);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    close() {
      clearTimeout(timer);
      controller.abort();
    },
  };
}

/** Count wire bytes before decoding; stop reading and cancel on excess or expiry. */
export async function readBrokerBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  budget: ReturnType<typeof createBrokerIoBudget>,
  complete?: (chunk: string) => boolean
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(Math.min(16_384, maxBytes));
  let bytes = 0;
  let ended = false;
  try {
    // Race the whole consumer once. Racing each chunk against the same pending
    // promise retains one deadline reaction per chunk until the timer settles.
    return await budget.run(async () => {
      for (;;) {
        budget.check();
        const { done, value } = await reader.read();
        budget.check();
        if (done) {
          ended = true;
          return new TextDecoder().decode(buffer.subarray(0, bytes));
        }
        if (bytes + value.byteLength > maxBytes) throw new BrokerIoError('payload_too_large');
        if (bytes + value.byteLength > buffer.byteLength) {
          const capacity = Math.min(maxBytes, Math.max(buffer.byteLength * 2, bytes + value.byteLength));
          const grown = new Uint8Array(capacity);
          grown.set(buffer.subarray(0, bytes));
          buffer = grown;
        }
        buffer.set(value, bytes);
        bytes += value.byteLength;
        if (complete?.(decoder.decode(value, { stream: true }))) {
          return new TextDecoder().decode(buffer.subarray(0, bytes));
        }
      }
    });
  } finally {
    // Cancellation can itself wait on an upstream; never extend the deadline.
    if (!ended) void reader.cancel('Broker body read finished').catch(() => undefined);
    reader.releaseLock();
  }
}
