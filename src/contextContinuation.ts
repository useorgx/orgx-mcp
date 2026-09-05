type ContextPreparation = Record<string, unknown>;

export interface ContextContinuation {
  version: string;
  serialized: string;
  data: ContextPreparation;
}
const MAX_BYTES = 8 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid context transfer');
  return value as Record<string, unknown>;
};
const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
async function versionOf(text: string) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_BYTES)
    throw new Error('Context transfer exceeds the client bound');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}

/** Reconstruct exact bytes before exposing context. This does not grant action authority. */
export async function applyContextTransfer(
  response: ContextPreparation,
  base?: ContextContinuation | null
): Promise<ContextContinuation> {
  const transfer = object(response.context_transfer);
  if (
    transfer.schema_version !== 'orgx.context-transfer/v1' ||
    typeof transfer.version !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(transfer.version)
  )
    throw new Error('Unsupported context transfer');
  let serialized: string;
  if (transfer.mode === 'full' && typeof transfer.serialized === 'string')
    serialized = transfer.serialized;
  else if (transfer.mode === 'delta') {
    if (
      !base ||
      transfer.base_version !== base.version ||
      (await versionOf(base.serialized)) !== base.version
    )
      throw new Error('Context base mismatch; rebootstrap required');
    if (
      !Array.isArray(transfer.operations) ||
      transfer.operations.length > 65536
    )
      throw new Error('Invalid context delta');
    const lines = linesOf(base.serialized);
    const chunks: string[] = [];
    let bytes = 0;
    for (const raw of transfer.operations) {
      const operation = object(raw);
      if (Object.keys(operation).length !== 1)
        throw new Error('Invalid context delta operation');
      let chunk: string;
      if (typeof operation.insert === 'string') chunk = operation.insert;
      else if (Array.isArray(operation.copy) && operation.copy.length === 2) {
        const [start, count] = operation.copy;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(count) ||
          start < 0 ||
          count <= 0 ||
          start + count > lines.length
        )
          throw new Error('Invalid context delta range');
        chunk = lines.slice(start, start + count).join('');
      } else throw new Error('Invalid context delta operation');
      bytes += new TextEncoder().encode(chunk).byteLength;
      if (bytes > MAX_BYTES)
        throw new Error('Context transfer exceeds the client bound');
      chunks.push(chunk);
    }
    serialized = chunks.join('');
  } else throw new Error('Unsupported context transfer mode');
  if ((await versionOf(serialized)) !== transfer.version)
    throw new Error('Context transfer digest mismatch');
  const data = object(JSON.parse(serialized));
  if (!data.context_delivery || typeof data.context_delivery !== 'object')
    throw new Error('Context delivery metadata is missing');
  return {
    version: transfer.version,
    serialized,
    data: data as ContextPreparation,
  };
}
