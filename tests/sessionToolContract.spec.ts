import { describe, expect, it, vi } from 'vitest';
import { assertMcpSessionIdentity, selectSessionToolContract } from '../src/sessionToolContract';
import { resolveRequestSessionToolContract } from '../src/requestSessionToolContract';
import { buildWidgetToolSurface } from '../src/widgetToolSurface';
import { resolveToolProfile } from '../src/toolProfiles';
import { resolveOperationCompatibilityCall } from '../src/operationCompatibility';

describe('MCP session contract binding', () => {
  it.each(['v2', 'chatgpt', 'claude-directory', 'read-only', 'commander', 'full'])(
    'requires a reconnect for a pre-operation initialized %s session', (previousProfile) => {
      expect(() => selectSessionToolContract({ initialized: true, requestedProfile: previousProfile }))
        .toThrow('Reconnect without a session ID');
    },
  );
  it('defaults a fresh session to operations and unknown selectors to read-only', () => {
    expect(selectSessionToolContract({ initialized: false })).toEqual({ profile: 'v2', contract_version: 'orgx-mcp-operations/1' });
    expect(selectSessionToolContract({ initialized: false, requestedProfile: 'typo' }).profile).toBe('read-only');
  });
  it('preserves a current binding and rejects obsolete or invalid persisted versions', () => {
    const stored = { profile: 'chatgpt', contract_version: 'orgx-mcp-operations/1' };
    expect(selectSessionToolContract({ initialized: true, stored, requestedProfile: 'extended' })).toEqual(stored);
    expect(() => selectSessionToolContract({ initialized: true, stored: { ...stored, contract_version: 'orgx-mcp-operations/0' } })).toThrow('Reconnect');
    expect(() => selectSessionToolContract({ initialized: true, stored: { ...stored, profile: 'typo' } })).toThrow('Reconnect');
  });
  it('never lets a stored internal profile become an external grant', () => {
    const stored = { profile: 'full', contract_version: 'orgx-mcp-legacy/1' };
    expect(() => selectSessionToolContract({ initialized: true, stored })).toThrow('Reconnect');
    expect(selectSessionToolContract({ initialized: true, stored, internalRun: true })).toEqual(stored);
    expect(selectSessionToolContract({ initialized: false, requestedProfile: 'full' }).profile).toBe('read-only');
  });
  it('rejects identity replacement and anonymous use of an authenticated session', () => {
    expect(() => assertMcpSessionIdentity('owner', 'other')).toThrow('another authenticated identity');
    expect(() => assertMcpSessionIdentity('owner')).toThrow('another authenticated identity');
    expect(() => assertMcpSessionIdentity('owner', 'owner')).not.toThrow();
  });
  it('looks up the authenticated current binding before projecting tools', async () => {
    const stored = { profile: 'chatgpt', contract_version: 'orgx-mcp-operations/1' };
    const stub = { getSessionToolContract: vi.fn(async () => stored) };
    const resolver = vi.fn(async () => stub);
    const binding = await resolveRequestSessionToolContract(
      new Request('https://mcp.test/mcp?profile=chatgpt', { headers: { 'mcp-session-id': 'session' } }),
      { MCP_OBJECT: {} }, { userId: 'owner', profile: 'chatgpt', toolProfileExplicit: true }, resolver,
    );
    expect(resolver).toHaveBeenCalledWith({}, 'streamable-http:session');
    expect(stub.getSessionToolContract).toHaveBeenCalledWith('owner');
    expect(binding).toEqual(stored);
    const surface = buildWidgetToolSurface(binding!.profile, new Set(['orgx_list_work_receipts']), resolveToolProfile(binding!.profile).tools!);
    expect(surface.contract_version).toBe('orgx-mcp-operations/1');
    expect(surface.widget_tools.receipt_list).toBe('orgx_list_work_receipts');
  });
  it('rejects an explicit profile change before invoking another tool', async () => {
    await expect(resolveRequestSessionToolContract(
      new Request('https://mcp.test/mcp', { headers: { 'mcp-session-id': 'session' } }),
      { MCP_OBJECT: {} }, { userId: 'owner', profile: 'extended', toolProfileExplicit: true },
      async () => ({ getSessionToolContract: async () => ({ profile: 'chatgpt', contract_version: 'orgx-mcp-operations/1' }) }),
    )).rejects.toThrow('Reconnect');
  });
  it('uses native SSE names and leaves unknown sessions to the SDK', async () => {
    const resolver = vi.fn(async () => ({ getSessionToolContract: async () => null }));
    expect(await resolveRequestSessionToolContract(
      new Request('https://mcp.test/sse/message?sessionId=s', { method: 'POST' }),
      { MCP_OBJECT: {} }, { userId: 'owner' }, resolver,
    )).toBeNull();
    expect(resolver).toHaveBeenCalledWith({}, 'sse:s');
  });
});

describe('bounded operation compatibility mappings', () => {
  it('maps only schema-valid same-handler reads absent from the actual inventory', () => {
    expect(resolveOperationCompatibilityCall('get_agent_status', {}, 'v2')?.toolId).toBe('orgx_get_agent_status');
    expect(resolveOperationCompatibilityCall('get_agent_status', { invented: true }, 'v2')).toBeNull();
    expect(resolveOperationCompatibilityCall('get_agent_status', {}, 'legacy')).toBeNull();
    expect(resolveOperationCompatibilityCall('manage_lifecycle', { action: 'pause', id: 'x', type: 'task' }, 'read-only')).toBeNull();
  });
  it('never turns reporting, bootstrap, or approvals into a different write or human authority', () => {
    for (const toolId of ['orgx_bootstrap', 'orgx_write', 'orgx_plan', 'orgx_report_work', 'approve_decision', 'reject_decision']) {
      expect(resolveOperationCompatibilityCall(toolId, {}, 'v2')).toBeNull();
    }
    expect(resolveOperationCompatibilityCall('approve_agent_work', { action: 'approve', decision_id: 'x' }, 'v2')).toBeNull();
    expect(resolveOperationCompatibilityCall('orgx_decide', { action: 'remember', decision: 'A write' }, 'v2')).toBeNull();
    expect(resolveOperationCompatibilityCall('manage_lifecycle', { action: 'pause', type: 'task', id: 'x' }, 'v2')).toBeNull();
  });
});
