import {
  McpSessionProfileConflictError, selectSessionToolContract,
  type SessionToolContract, type SessionAuthenticatedGrant,
} from './sessionToolContract';

export type SessionContractStub = {
  getSessionToolContract(grant: SessionAuthenticatedGrant): Promise<SessionToolContract | null>;
};
type StubResolver = (namespace: unknown, name: string) => Promise<SessionContractStub>;

/** Lookup occurs after authentication, before aliases or telemetry infer a contract. */
export async function resolveRequestSessionToolContract(
  request: Request,
  env: { MCP_OBJECT?: unknown },
  props: SessionAuthenticatedGrant & { profile?: string; toolProfileExplicit?: boolean },
  resolveStub: StubResolver = async (namespace, name) => {
    // This preflight reads persisted identity/grant/contract only. The agents
    // helper first awaits a set-name fetch (and full onStart on a cold object),
    // then the SDK repeats that setup on actual transport dispatch. A direct
    // RPC preserves the fresh authorization check without that extra hop or
    // initializing a registry before the authenticated grant has been checked.
    // Leave naming, props persistence, and transport initialization to the SDK.
    const objects = namespace as Pick<DurableObjectNamespace, 'idFromName' | 'get'>;
    return objects.get(objects.idFromName(name)) as unknown as SessionContractStub;
  }
): Promise<SessionToolContract | null> {
  const url = new URL(request.url);
  const sessionId = request.headers.get('mcp-session-id')?.trim() || url.searchParams.get('sessionId')?.trim();
  if (!sessionId || !env.MCP_OBJECT) return null;
  if (!props.userId) throw new McpSessionProfileConflictError();
  // The POST /sse alias uses streamable HTTP; the native message endpoint uses SSE.
  const kind = url.pathname.startsWith('/sse/message') || (url.pathname === '/sse' && request.method === 'GET')
    ? 'sse' : 'streamable-http';
  const stub = await resolveStub(env.MCP_OBJECT, `${kind}:${sessionId}`);
  const { userId, scope, authSource, runId, scopes, workspace_id } = props;
  const stored = await stub.getSessionToolContract({ userId, scope, authSource, runId, scopes, workspace_id });
  if (!stored) return null; // The SDK returns its normal session-not-found response.
  const binding = selectSessionToolContract({ stored, initialized: true, internalRun: props.authSource === 'run_token' });
  if (props.toolProfileExplicit && props.profile !== binding.profile) {
    throw new McpSessionProfileConflictError();
  }
  return binding;
}
