import { describe, expect, it } from 'vitest';
import { buildMetricExpectationRequest } from '../src/metricExpectationContract';
import { RegisterMetricExpectationSchema } from '../src/generated/metricExpectationInput';
import fixtures from './fixtures/metric-registration-v1.json';

describe('metric registration MCP profile', () => {
  it.each(fixtures.filter((fixture) => fixture.portableCore))('portable core profile: $name', (fixture) => {
    const input = fixture.mode === 'request' ? fixture.input : fixture.mcp!.body;
    const parsed = RegisterMetricExpectationSchema.safeParse(input);
    const actual = parsed.success ? { ok: true, data: parsed.data } : { ok: false, issues: parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })) };
    expect(actual).toEqual(fixture.portableCore);
  });
  it.each(fixtures.filter((fixture) => fixture.mode === 'builder'))('$name', (fixture) => {
    const result = buildMetricExpectationRequest(fixture.args!, { workspaceId: fixture.workspaceId! });
    const actual = result.ok && result.idempotencyKeyGenerated ? { ...result, idempotencyKey: '<generated>' } : result;
    expect(actual).toEqual(fixture.mcp);
    if (result.ok && result.idempotencyKeyGenerated) expect(result.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});
