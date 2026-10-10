import { describe, expect, it } from 'vitest';
import {
  boundedMcpCompatibilityMappingId, boundedMcpCompatibilityToolId,
  buildMcpCompatibilityMetadata, isMcpCompatibilityActivity,
  MCP_LEGACY_CONTRACT_VERSION, MCP_OPERATION_CONTRACT_VERSION,
  parseMcpCompatibilityInvocationRow,
} from '../src/mcpCompatibility';
import { sanitizeWorkerTelemetryProperties } from '../src/workerTelemetryPrivacy';

describe('MCP compatibility observation boundary', () => {
  it('records the original namespace and handler identity independently from the routed operation', () => {
    const metadata = buildMcpCompatibilityMetadata({
      requestedToolId: 'OrgX:get_agent_status', normalizedToolId: 'get_agent_status',
      executedToolId: 'orgx_get_agent_status', registeredToolId: 'orgx_get_agent_status',
      profile: 'v2', contractVersion: MCP_OPERATION_CONTRACT_VERSION, outcome: 'error',
    });
    expect(metadata).toMatchObject({
      requested_tool_id: 'orgx:get_agent_status', normalized_tool_id: 'get_agent_status',
      executed_tool_id: 'orgx_get_agent_status', registered_tool_id: 'orgx_get_agent_status',
      operation_contract_version: MCP_OPERATION_CONTRACT_VERSION,
      compatibility_mapping_status: 'mapped', compatibility_mapping_id: 'get_agent_status=>orgx_get_agent_status',
      compatibility_outcome: 'error', tool_namespace: 'orgx', legacy_tool_call: true,
    });
    expect(sanitizeWorkerTelemetryProperties(metadata)).toEqual(metadata);
  });

  it('keeps bounded migration labels before transport timing fields for the existing intake limit', () => {
    const metadata = buildMcpCompatibilityMetadata({
      requestedToolId: 'orgx_get_work_receipt', normalizedToolId: 'orgx_get_work_receipt',
      profile: 'v2', outcome: 'success',
    });
    const combined = { ...metadata, ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`timing_${i}`, i])) };
    const persisted = Object.fromEntries(Object.entries(combined).slice(0, 32));
    expect(persisted).toMatchObject(metadata);
    expect(metadata).toMatchObject({ compatibility_mapping_status: 'none', legacy_tool_call: false });
  });

  it('does not turn an unknown or rejected attempt into inactivity or expose its raw payload', () => {
    const privateText = 'secret-sentinel@customer.example';
    const metadata = buildMcpCompatibilityMetadata({
      requestedToolId: privateText, normalizedToolId: privateText,
      executedToolId: privateText, profile: 'read-only', outcome: 'error',
      legacyAction: privateText, mappingId: privateText, mappingStatus: 'unsupported',
    });
    expect(JSON.stringify(sanitizeWorkerTelemetryProperties(metadata))).not.toContain(privateText);
    expect(metadata).toMatchObject({ requested_tool_id: 'other', normalized_tool_id: 'other',
      compatibility_mapping_status: 'unsupported', compatibility_outcome: 'error', legacy_tool_call: true });
  });

  it.each(['orgx_get_workspace_context', 'orgx_submit_work_receipt', 'orgx_validate_work_receipt',
    'orgx_widget_approve_artifact', 'orgx_start_agent_task', 'orgx_complete_work_with_proof'])(
    'preserves current catalog id %s instead of dropping it into other', (toolId) => {
      expect(sanitizeWorkerTelemetryProperties({ tool_id: toolId })).toEqual({ tool_id: toolId });
    }
  );

  it('rejects invented namespaces and mapping targets even when one side is a known tool', () => {
    expect(boundedMcpCompatibilityToolId('attacker:orgx_search', true)).toBe('other');
    expect(boundedMcpCompatibilityToolId('orgx_get_work_receipt')).toBe('orgx_get_work_receipt');
    expect(boundedMcpCompatibilityToolId('mcp__orgx-mcp__orgx_get_work_receipt', true)).toBe('mcp__orgx-mcp__orgx_get_work_receipt');
    expect(boundedMcpCompatibilityMappingId('get_agent_status=>secret-sentinel')).toBe('other');
    expect(boundedMcpCompatibilityMappingId('get_agent_status=>orgx_get_agent_status=>orgx_search')).toBe('other');
    // SDK tool IDs are case-sensitive even though recognized namespace prefixes are not.
    expect(boundedMcpCompatibilityToolId('OrgX:ORGX_SEARCH', true)).toBe('other');
    expect(boundedMcpCompatibilityToolId('ORGX_SEARCH')).toBe('other');
  });

  it('recognizes legacy contracts even when their tool id also exists in the current catalog', () => {
    const metadata = buildMcpCompatibilityMetadata({ requestedToolId: 'orgx_search',
      normalizedToolId: 'orgx_search', profile: 'legacy', outcome: 'success' });
    expect(metadata.operation_contract_version).toBe(MCP_LEGACY_CONTRACT_VERSION);
    expect(metadata.legacy_tool_call).toBe(true);
  });

  it('reads durable legacy/error rows conservatively and rejects malformed rows for the read-completeness gate', () => {
    const row = parseMcpCompatibilityInvocationRow({ created_at: '2026-10-08T12:00:00.000Z',
      tool_id: 'orgx_search', status: 'error', client_name: 'chatgpt', metadata: {} });
    expect(row).not.toBeNull();
    expect(isMcpCompatibilityActivity(row!)).toBe(true);
    expect(parseMcpCompatibilityInvocationRow({ created_at: 'bad', tool_id: 'orgx_search', status: 'success' })).toBeNull();
    expect(parseMcpCompatibilityInvocationRow({ created_at: '2026-10-08T12:00:00.000Z', tool_id: 'orgx_search', status: 'started' })).toBeNull();
  });

  it('does not trust a false legacy flag when another field shows an unknown or old registration', () => {
    const row = parseMcpCompatibilityInvocationRow({ created_at: '2026-10-08T12:00:00.000Z',
      tool_id: 'orgx_get_agent_status', status: 'success', metadata: {
        operation_contract_version: MCP_OPERATION_CONTRACT_VERSION,
        legacy_tool_call: false, registered_tool_id: 'get_agent_status',
      } });
    expect(isMcpCompatibilityActivity(row!)).toBe(true);
  });
});
