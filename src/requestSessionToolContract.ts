import {
  McpSessionProfileConflictError, selectSessionToolContract,
  type SessionToolContract,
} from './sessionToolContract';

export type SessionContractStub = {
  getSessionToolContract(userId: string): Promise<SessionToolContract | null>;
};
type StubResolver = (namespace: unknown, name: string) => Promise<SessionContractStub>;

/** Lookup occurs after authentication, before aliases or telemetry infer a contract. */
export async function resolveRequestSessionToolContract(
  request: Request,
  env: { MCP_OBJECT?: unknown },
  props: { userId?: string; profile?: string; toolProfileExplicit?: boolean; authSource?: string },
  resolveStub: StubResolver = async (namespace, name) => {
    const { getAgentByName } = await import('agents');
    return await getAgentByName(namespace as never, name) as unknown as SessionContractStub;
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
  const stored = await stub.getSessionToolContract(props.userId);
  if (!stored) return null; // The SDK returns its normal session-not-found response.
  const binding = selectSessionToolContract({ stored, initialized: true, internalRun: props.authSource === 'run_token' });
  if (props.toolProfileExplicit && props.profile !== binding.profile) {
    throw new McpSessionProfileConflictError();
  }
  return binding;
}
