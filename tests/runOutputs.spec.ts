import { afterEach, describe, expect, it, vi } from 'vitest';

import { CANONICAL_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas/canonical';
import { fetchRunOutputs, formatRunOutputs, type RunOutput } from '../src/runOutputs';

const env = {
  ORGX_API_URL: 'https://api.example.test',
  ORGX_SERVICE_KEY: 'oxk-test-service-key',
  ORGX_API_TIMEOUT_MS: '200',
};

const answer: RunOutput = {
  id: 'a1',
  title: 'Continuity answer',
  type: 'document',
  summary: 'Found the decision',
  excerpt: 'CODENAME=amber-1234',
  truncated: false,
  url: null,
  createdAt: '2026-09-28T04:07:20Z',
};

describe('run outputs for orgx_inspect', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the run output endpoint for the caller', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { outputs: [answer] } }));
    vi.stubGlobal('fetch', fetchMock);
    const outputs = await fetchRunOutputs(env, 'run-1', { userId: 'user-1', runId: 'run-9', workspaceId: 'ws-1' });
    expect(outputs).toEqual([answer]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/runs/run-1/output');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('never fails inspect: errors and odd payloads return null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'nope' }, { status: 404 })));
    expect(await fetchRunOutputs(env, 'run-1', { userId: 'user-1' })).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data: {} })));
    expect(await fetchRunOutputs(env, 'run-1', { userId: 'user-1' })).toBeNull();
  });

  it('puts the answer in the text an LLM reads', () => {
    expect(formatRunOutputs([answer])).toBe('Outputs (newest first):\n- Continuity answer: CODENAME=amber-1234');
    expect(formatRunOutputs([])).toBeNull();
  });

  it('is part of the published orgx_inspect schema', () => {
    const payload = { _v2_tool: 'orgx_inspect', type: 'run', id: 'run-1', entity: { id: 'run-1' }, outputs: [answer] };
    expect(() => CANONICAL_OUTPUT_SCHEMAS.orgx_inspect.parse(payload)).not.toThrow();
  });
});
