/**
 * streamGrant.ts — hand a widget everything it needs to subscribe.
 *
 * A sandboxed widget cannot mint its own stream token, so the token has to ride
 * along in the tool payload. Previously only the two server-generated HTML
 * widgets got one, which is why the ten static widgets in public/widgets/ had no
 * way to go live even though the transport existed.
 *
 * A grant is embedded as `structuredContent.live`, so any tool can make its
 * widget live by calling `buildStreamGrant` and attaching the result — and the
 * widget's own `live-store.js` knows how to read it without per-tool wiring.
 *
 * The grant also carries `expiresAt`. A widget that knows when its token dies can
 * refresh proactively by re-invoking `refreshTool`, rather than waiting for the
 * stream to fail.
 */

import { signStreamToken } from '../streamToken';
import { getFeed } from './feedRegistry';

export interface StreamGrant {
  feedType: string;
  feedId: string;
  /** Absolute SSE URL with the signed token already attached. */
  streamUrl: string;
  /** Epoch ms the token stops being accepted. */
  expiresAt: number;
  /** Tool the widget re-invokes to obtain a fresh grant. */
  refreshTool: string;
  /** Arguments to pass back to `refreshTool`. */
  refreshArgs: Record<string, string>;
  /** Human label for the feed, for the widget's header fallback. */
  label: string;
}

/**
 * Live-feed grants are deliberately short-lived.
 *
 * The signed URL reaches the widget through the tool result, so it is exposed
 * more widely than a credential minted inside a request. The widget refreshes
 * through its bound MCP tool, which costs one call, so the only thing a long
 * lifetime buys is a longer replay window for a leaked URL.
 */
export const LIVE_GRANT_TTL_MS = 15 * 60 * 1000;

/**
 * Lifetime for the token baked into the server-generated HTML widget.
 *
 * That widget is standalone: no MCP tool handle, so no way to obtain a fresh
 * token. The short grant lifetime above only works because a widget holding a
 * grant can re-invoke its bound tool. Applying it here would simply end the
 * widget's updates sooner, with nothing it could do about it.
 */
export const GENERATED_WIDGET_TTL_MS = 60 * 60 * 1000;

export async function buildStreamGrant(input: {
  feedType: string;
  feedId: string;
  serverUrl: string;
  secret: string;
  refreshTool: string;
  refreshArgs?: Record<string, string>;
  userId?: string;
}): Promise<StreamGrant | null> {
  const feed = getFeed(input.feedType);
  if (!feed) return null;
  if (!input.feedId || !input.secret || !input.serverUrl) return null;

  const token = await signStreamToken({
    feedType: input.feedType,
    feedId: input.feedId,
    ...(input.userId ? { userId: input.userId } : {}),
    secret: input.secret,
    ttlMs: LIVE_GRANT_TTL_MS,
  });

  const base = input.serverUrl.replace(/\/+$/, '');
  const streamUrl =
    `${base}/live-feed/${input.feedType}/${encodeURIComponent(input.feedId)}` +
    `/stream?t=${encodeURIComponent(token)}`;

  return {
    feedType: input.feedType,
    feedId: input.feedId,
    streamUrl,
    // Reported slightly short of the real exp so a widget that refreshes on
    // this value always beats the server's own expiry warning.
    expiresAt: Date.now() + LIVE_GRANT_TTL_MS - 30_000,
    refreshTool: input.refreshTool,
    refreshArgs: input.refreshArgs ?? {},
    label: feed.label,
  };
}

/**
 * Which feed a widget tool should subscribe to, and the tool that refreshes it.
 * Keeping this beside the registry means a tool becomes live by gaining a row
 * here rather than by growing its own token plumbing.
 */
// Only feeds present in FEEDS may be bound here; buildStreamGrant returns null
// for anything else, so a stale binding degrades to a static widget rather than
// a broken subscription.
export const TOOL_FEED_BINDINGS: Record<
  string,
  { feedType: string; refreshTool: string }
> = {
  get_agent_status: { feedType: 'agent-status', refreshTool: 'get_agent_status' },
  get_initiative_pulse: {
    feedType: 'initiative-pulse',
    refreshTool: 'get_initiative_pulse',
  },
  spawn_agent_task: { feedType: 'agent-status', refreshTool: 'get_agent_status' },
  delegate_agent_task: { feedType: 'agent-status', refreshTool: 'get_agent_status' },
  orgx_spawn: { feedType: 'agent-status', refreshTool: 'get_agent_status' },
  scaffold_initiative: {
    feedType: 'initiative-pulse',
    refreshTool: 'get_initiative_pulse',
  },
  // The decision queue is the one feed scoped to a person rather than an
  // initiative; see FeedDefinition.scope.
  get_pending_decisions: {
    feedType: 'decisions',
    refreshTool: 'get_pending_decisions',
  },
  orgx_decide: { feedType: 'decisions', refreshTool: 'get_pending_decisions' },
};

export function feedBindingForTool(
  toolId: string
): { feedType: string; refreshTool: string } | null {
  return Object.prototype.hasOwnProperty.call(TOOL_FEED_BINDINGS, toolId)
    ? TOOL_FEED_BINDINGS[toolId]!
    : null;
}
