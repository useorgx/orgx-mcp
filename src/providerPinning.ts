/**
 * Provider-pinning verification (A1).
 *
 * When a spawn requests a specific provider/model, nothing checked that the
 * backend actually HONORED it end-to-end — a silent fallback to a different
 * provider would go unnoticed. This compares the requested pin against what the
 * tool-execute response reports it used, so a mismatch becomes an observable
 * telemetry signal. Pure and defensive: returns null when nothing was pinned
 * (provider 'auto' / absent), so it never fabricates a mismatch.
 */

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readStr(d: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const s = str(d[k]);
    if (s) return s;
  }
  return undefined;
}

export interface ProviderPinningCheck {
  requested_provider?: string;
  used_provider?: string;
  requested_model?: string;
  used_model?: string;
  provider_mismatch: boolean;
  model_mismatch: boolean;
}

export function detectProviderPinning(
  requested: { provider?: unknown; model?: unknown },
  data: Record<string, unknown> | null | undefined
): ProviderPinningCheck | null {
  const reqProvider = str(requested.provider);
  // 'auto' (or absent) means no pin was requested — nothing to verify.
  const pinnedProvider =
    reqProvider && reqProvider.toLowerCase() !== 'auto' ? reqProvider : undefined;
  const pinnedModel = str(requested.model);
  if (!pinnedProvider && !pinnedModel) return null;

  const d = asRecord(data);
  const usedProvider =
    readStr(d, ['provider', 'model_provider', 'modelProvider', 'provider_used', 'providerUsed']) ??
    readStr(asRecord(d.runtime), ['provider', 'source_provider']);
  const usedModel = readStr(d, ['model', 'model_id', 'modelId', 'model_used', 'modelUsed']);

  return {
    requested_provider: pinnedProvider,
    used_provider: usedProvider,
    requested_model: pinnedModel,
    used_model: usedModel,
    provider_mismatch: Boolean(
      pinnedProvider && usedProvider && pinnedProvider.toLowerCase() !== usedProvider.toLowerCase()
    ),
    model_mismatch: Boolean(pinnedModel && usedModel && pinnedModel !== usedModel),
  };
}
