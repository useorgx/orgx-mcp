/**
 * Rewrite JSON-RPC messages inside a Server-Sent Events stream without
 * otherwise touching it: event ids (resumability), event names and retry
 * hints pass through as they are, and events that are not JSON pass through
 * byte for byte. Used to filter `tools/list` results on Streamable HTTP
 * responses, including streams resumed with Last-Event-ID.
 */

export type JsonRpcRewrite = (message: unknown) => unknown;

// SSE lines end in CRLF, LF or a lone CR; an event ends at a blank line. A
// CR directly followed by LF is one line ending, never two.
const LINE_END = /\r\n|\r|\n/;
const EVENT_END = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/;

/** Apply `rewrite` to one JSON-RPC message or a batch. */
export function rewriteJsonRpc(payload: unknown, rewrite: JsonRpcRewrite): unknown {
  return Array.isArray(payload) ? payload.map(rewrite) : rewrite(payload);
}

function rewriteEvent(block: string, rewrite: JsonRpcRewrite): string {
  const lines = block.split(LINE_END);
  const dataLines: string[] = [];
  let firstDataIndex = -1;
  lines.forEach((line, index) => {
    if (line.startsWith('data:')) {
      if (firstDataIndex === -1) firstDataIndex = index;
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  });
  if (firstDataIndex === -1) return block;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join('\n'));
  } catch {
    return block;
  }
  const next = JSON.stringify(rewriteJsonRpc(parsed, rewrite));
  const kept = lines.filter((line) => !line.startsWith('data:'));
  kept.splice(Math.min(firstDataIndex, kept.length), 0, `data: ${next}`);
  return kept.join('\n');
}

/** Streams `body` through, rewriting each event's JSON-RPC payload. */
export function rewriteSseStream(
  body: ReadableStream<Uint8Array>,
  rewrite: JsonRpcRewrite
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const drain = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
    for (;;) {
      const match = EVENT_END.exec(buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      // A CR at the very end may be the first half of a CRLF still in flight.
      if (!final && end === buffer.length && buffer.endsWith('\r')) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(end);
      controller.enqueue(encoder.encode(`${rewriteEvent(block, rewrite)}\n\n`));
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        drain(controller, false);
      },
      flush(controller) {
        buffer += decoder.decode();
        drain(controller, true);
        if (buffer) controller.enqueue(encoder.encode(rewriteEvent(buffer, rewrite)));
      },
    })
  );
}

/** Every JSON-RPC message in a buffered SSE body (for the broker's own calls). */
export function parseSseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of text.split(EVENT_END)) {
    const data = block
      .split(LINE_END)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // Not JSON: ignore.
    }
  }
  return messages;
}
