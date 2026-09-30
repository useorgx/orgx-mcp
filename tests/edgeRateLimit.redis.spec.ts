import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetEdgeRateLimitStateForTests, checkEdgeRateLimit } from '../src/edgeRateLimit';

const exec = promisify(execFile);
const cli = process.env.ORGX_TEST_REDIS_CLI;
const socket = process.env.ORGX_TEST_REDIS_SOCKET;
// Explicit opt-in to an isolated local Unix socket; never use production Redis.
describe.skipIf(!cli || !socket)('atomic admission against isolated Redis', () => {
  afterEach(() => { vi.unstubAllGlobals(); __resetEdgeRateLimitStateForTests(); });
  it('admits exactly the allowance under concurrent requests and never charges rejections', async () => {
    if (!socket?.startsWith('/tmp/')) throw new Error('test Redis must use a temporary Unix socket');
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (url !== 'https://isolated-redis.invalid') throw new Error('unexpected network request');
      const command = JSON.parse(String(init?.body)) as Array<string | number>;
      const { stdout } = await exec(cli!, ['-s', socket!, '--json', ...command.map(String)]);
      return Response.json({ result: JSON.parse(stdout) });
    }));
    const env = {
      ORGX_API_URL: 'https://app.invalid', ORGX_SERVICE_KEY: 'oxk-test',
      UPSTASH_REDIS_REST_URL: 'https://isolated-redis.invalid', UPSTASH_REDIS_REST_TOKEN: 'local-test',
    };
    const ip = randomUUID();
    const request = () => new Request('https://mcp.invalid/mcp', { headers: { 'cf-connecting-ip': ip } });
    const decisions = await Promise.all(Array.from({ length: 140 }, () => checkEdgeRateLimit(request(), env)));
    expect(decisions.every((decision) => decision.source === 'upstash')).toBe(true);
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(100);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(40);
    const key = 'mcp:rate:base:ip:' + ip;
    const card = await exec(cli!, ['-s', socket!, '--raw', 'ZCARD', key]);
    expect(Number(card.stdout)).toBe(100);
    const before = await exec(cli!, ['-s', socket!, '--raw', 'ZRANGE', key, '0', '0', 'WITHSCORES']);
    for (let i = 0; i < 5; i++) expect((await checkEdgeRateLimit(request(), env)).allowed).toBe(false);
    const after = await exec(cli!, ['-s', socket!, '--raw', 'ZRANGE', key, '0', '0', 'WITHSCORES']);
    expect(after.stdout).toBe(before.stdout);
    const ttl = await exec(cli!, ['-s', socket!, '--raw', 'PTTL', key]);
    expect(Number(ttl.stdout)).toBeGreaterThan(0);
    expect(Number(ttl.stdout)).toBeLessThanOrEqual(3600000);
    await exec(cli!, ['-s', socket!, '--raw', 'DEL', key]);
  }, 30000);
});

