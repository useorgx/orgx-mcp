/**
 * Shared deep-link entity type normalization.
 *
 * This module intentionally avoids binding to a specific URL scheme. App and
 * worker link builders can share the same type normalization and alias policy
 * while preserving environment-specific route mappings.
 */

import { ENTITY_TYPES, type EntityType } from './entity';

export const DEEPLINK_EXTRA_ENTITY_TYPES = [
  'workspace',
  'session',
  'agent_run',
  'live',
  'live_ops',
  'live_operations',
] as const;

export type DeeplinkExtraEntityType = (typeof DEEPLINK_EXTRA_ENTITY_TYPES)[number];

export type DeeplinkEntityType = EntityType | DeeplinkExtraEntityType;

export const DEEPLINK_ENTITY_ALIASES: Readonly<Record<string, DeeplinkEntityType>> =
  {
    'command-center': 'command_center',
    commandcenter: 'command_center',
    workspace: 'workspace',
    agentrun: 'agent_run',
    'agent-run': 'agent_run',
    liveops: 'live_ops',
    'live-ops': 'live_ops',
  };

const DEEPLINK_ENTITY_TYPE_SET: ReadonlySet<string> = new Set([
  ...ENTITY_TYPES,
  ...DEEPLINK_EXTRA_ENTITY_TYPES,
]);

export function normalizeDeeplinkEntityType(
  value: unknown
): DeeplinkEntityType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '');
  if (!normalized) return null;
  const canonical = DEEPLINK_ENTITY_ALIASES[normalized] ?? normalized;
  const snake = canonical.replace(/-/g, '_');
  return DEEPLINK_ENTITY_TYPE_SET.has(snake)
    ? (snake as DeeplinkEntityType)
    : null;
}
