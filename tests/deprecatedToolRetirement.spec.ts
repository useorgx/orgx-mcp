import { describe, expect, it } from 'vitest';
import { MCP_COMPATIBILITY_RETIREMENT_POLICY, withDeprecatedToolWarningHeaders } from '../src/deprecatedTools';

describe('compatibility warnings support a coordinated upgrade', () => {
  it('removes stale expiry declarations and retains the committed response untouched', async () => {
    const response = withDeprecatedToolWarningHeaders(Response.json({ committed: true }, { status: 201,
      headers: { Sunset: 'Sun, 21 Jun 2026 00:00:00 GMT', 'x-orgx-deprecation-sunset-at': '2026-06-21T00:00:00.000Z' },
    }), { deprecatedToolId: 'get_agent_status', replacementToolId: 'orgx_get_agent_status', routed: true });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ committed: true });
    expect(response.headers.get('Sunset')).toBeNull();
    expect(response.headers.get('x-orgx-deprecation-sunset-at')).toBeNull();
    expect(response.headers.get('x-orgx-deprecation-retirement-policy')).toBe(MCP_COMPATIBILITY_RETIREMENT_POLICY);
    expect(response.headers.get('Warning')).toContain('Update the client and reconnect');
    expect(response.headers.get('Warning')).not.toContain('2026-06-21');
  });

  it('reports a bounded list for a batch without discarding its individual warning count', () => {
    const warnings = Array.from({ length: 30 }, (_, i) => ({ deprecatedToolId: `old_${i}`,
      replacementToolId: 'orgx_search', routed: false }));
    const response = withDeprecatedToolWarningHeaders(Response.json([]), warnings);
    expect(response.headers.get('x-orgx-deprecated-call-count')).toBe('30');
    expect(response.headers.get('x-orgx-deprecated-tools')?.split(', ')).toHaveLength(16);
    expect(response.headers.get('Sunset')).toBeNull();
  });
});
