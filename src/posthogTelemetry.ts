export type PosthogTelemetryEnv = {
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
};

type WaitUntilLike = {
  waitUntil?: (promise: Promise<unknown>) => unknown;
};

export function resolveAnonymousDistinctId(ctx: unknown): string {
  try {
    const id = (ctx as { id?: { toString?: () => string } })?.id?.toString?.();
    if (typeof id === 'string' && id.length > 0) return `mcp:${id}`;
  } catch {
    // ignore
  }
  return 'mcp:anonymous';
}

export function captureWorkerPosthogEvent(params: {
  env: PosthogTelemetryEnv;
  ctx?: WaitUntilLike | null;
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
  serverVersion?: string;
}): void {
  try {
    const apiKey = params.env.POSTHOG_KEY;
    if (!apiKey || apiKey === 'test-posthog-key') return;

    const host = (
      params.env.POSTHOG_HOST || 'https://us.i.posthog.com'
    ).replace(/\/+$/, '');

    const sentAt = new Date().toISOString();
    const eventProperties: Record<string, unknown> = {
      ...(params.properties ?? {}),
      $lib: 'orgx-mcp',
    };

    if (params.serverVersion) {
      eventProperties.$lib_version = params.serverVersion;
      eventProperties.mcp_server_version = params.serverVersion;
    }

    const payload = {
      api_key: apiKey,
      batch: [
        {
          type: 'capture',
          event: params.event,
          distinct_id: params.distinctId,
          properties: eventProperties,
          timestamp: sentAt,
        },
      ],
      sent_at: sentAt,
    };

    const request = fetch(`${host}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(() => undefined)
      .catch(() => undefined);

    params.ctx?.waitUntil?.(request);
  } catch {
    // ignore
  }
}
