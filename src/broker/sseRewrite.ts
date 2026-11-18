/**
 * Rewrite JSON-RPC messages inside a Server-Sent Events stream without
 * otherwise touching it: event ids (resumability), event names and retry
 * hints pass through as they are, and events that are not JSON pass through
 * byte for byte. Used to filter `tools/list` results on Streamable HTTP
 * responses, including streams resumed with Last-Event-ID.
 */

export type JsonRpcRewrite = (message: unknown) => unknown;

import { BrokerIoError } from './brokerIoBudget';

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

/**
 * A pending catalog must be filtered before it reaches the client. Count each
 * event's wire bytes without repeatedly scanning an incomplete event. Mixed
 * batches share this bound until all catalog replies arrive; afterward their
 * tool results keep the existing stream behavior. No SSE lifetime limit.
 */
export function rewriteCatalogSseStream(
  body: ReadableStream<Uint8Array>,
  rewrite: JsonRpcRewrite,
  catalogPending: () => boolean,
  maxEventBytes: number
): ReadableStream<Uint8Array> {
  // Coalesce tiny network chunks; retaining one object per byte defeats a byte cap.
  let buffer = new Uint8Array(16_384);
  let written = 0;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const trailingBoundary = new RegExp(`${EVENT_END.source}$`);
  let eventBytes = 0;
  let lineHasContent = false;
  let skipLf = false;
  let discardLf = false;
  const append = (bytes: Uint8Array) => {
    if (written + bytes.byteLength > buffer.byteLength) {
      const grown = new Uint8Array(Math.max(buffer.byteLength * 2, written + bytes.byteLength));
      grown.set(buffer.subarray(0, written));
      buffer = grown;
    }
    buffer.set(bytes, written);
    written += bytes.byteLength;
  };
  const count = () => {
    eventBytes += 1;
    if (catalogPending() && eventBytes > maxEventBytes) throw new BrokerIoError('payload_too_large');
  };
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, complete: boolean) => {
    const text = decoder.decode(buffer.subarray(0, written));
    const block = complete ? text.replace(trailingBoundary, '') : text;
    controller.enqueue(encoder.encode(rewriteEvent(block, rewrite) + (complete ? '\n\n' : '')));
    written = 0;
    eventBytes = 0;
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let start = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        const byte = chunk[index];
        if (skipLf) {
          skipLf = false;
          if (byte === 10) {
            if (discardLf) start = index + 1;
            else count();
            discardLf = false;
            continue;
          }
          discardLf = false;
        }
        count();
        if (byte === 13 || byte === 10) {
          const complete = !lineHasContent;
          lineHasContent = false;
          skipLf = byte === 13;
          if (complete) {
            append(chunk.subarray(start, index + 1));
            emit(controller, true);
            start = index + 1;
            discardLf = byte === 13;
          }
        } else {
          lineHasContent = true;
        }
      }
      if (start < chunk.byteLength) append(chunk.subarray(start));
    },
    flush(controller) { if (eventBytes) emit(controller, false); },
  }));
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

/** Incremental catalog matcher: each character and completed event is read once. */
export function createSseMessageMatcher(expectedId: string): (chunk: string) => boolean {
  // Fixed-size pieces also bound allocation overhead for one-byte input chunks.
  const lineBuffer = new Uint16Array(4_096);
  const lineParts: string[] = [];
  let lineLength = 0;
  const flushLinePart = () => {
    if (lineLength) lineParts.push(String.fromCharCode(...lineBuffer.subarray(0, lineLength)));
    lineLength = 0;
  };
  let data: string[] = [];
  let skipLf = false;
  let matched = false;
  const endLine = () => {
    flushLinePart();
    const line = lineParts.join('');
    lineParts.length = 0;
    if (line === '') {
      try {
        const parsed = JSON.parse(data.join('\n')) as unknown;
        matched = (Array.isArray(parsed) ? parsed : [parsed]).some((message) =>
          message !== null && typeof message === 'object' && (message as { id?: unknown }).id === expectedId);
      } catch { /* Comments, heartbeats and non-JSON events are not replies. */ }
      data = [];
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  };
  return (chunk) => {
    for (const character of chunk) {
      if (skipLf) {
        skipLf = false;
        if (character === '\n') continue;
      }
      if (character === '\r' || character === '\n') {
        endLine();
        skipLf = character === '\r';
        if (matched) return true;
      } else {
        for (let unit = 0; unit < character.length; unit += 1) {
          lineBuffer[lineLength++] = character.charCodeAt(unit);
          if (lineLength === lineBuffer.length) flushLinePart();
        }
      }
    }
    return false;
  };
}
