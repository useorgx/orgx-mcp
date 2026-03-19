/**
 * Canonical OrgX entity type contracts.
 *
 * Keep this module dependency-free so it can be shared by app, server, and
 * worker code without pulling framework/runtime-specific code.
 */

export const ENTITY_TYPES = [
  'command_center',
  'project',
  'initiative',
  'milestone',
  'workstream',
  'task',
  'objective',
  'playbook',
  'decision',
  'artifact',
  'run',
  'blocker',
  'workflow',
  'agent',
  'skill',
  'plan_session',
  'stream',
  'studio_brand',
  'studio_content',
  'video_template',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const LIFECYCLE_ENTITY_TYPES = [
  'initiative',
  'milestone',
  'workstream',
  'task',
  'objective',
  'playbook',
  'decision',
  'stream',
  'studio_content',
] as const;

export type LifecycleEntityType = (typeof LIFECYCLE_ENTITY_TYPES)[number];

export const MISSION_CONTROL_NODE_TYPES = [
  'initiative',
  'workstream',
  'milestone',
  'task',
] as const;

export type MissionControlNodeType = (typeof MISSION_CONTROL_NODE_TYPES)[number];

export const ENTITY_COMMENT_ENTITY_TYPES = [
  'initiative',
  'workstream',
  'milestone',
  'task',
  'decision',
] as const;

export type EntityCommentEntityType =
  (typeof ENTITY_COMMENT_ENTITY_TYPES)[number];

export const VERIFIABLE_COMPLETION_ENTITY_TYPES = [
  'initiative',
  'workstream',
  'milestone',
  'task',
] as const;

export type VerifiableCompletionEntityType =
  (typeof VERIFIABLE_COMPLETION_ENTITY_TYPES)[number];

export const CONTEXT_ENTITY_TYPES = ['task', 'milestone', 'initiative'] as const;
export type ContextEntityType = (typeof CONTEXT_ENTITY_TYPES)[number];

export const INITIATIVE_CHILD_ENTITY_TYPES = [
  'workstream',
  'milestone',
  'task',
] as const;
export type InitiativeChildEntityType =
  (typeof INITIATIVE_CHILD_ENTITY_TYPES)[number];

export const ENTITY_TYPE_SET: ReadonlySet<EntityType> = new Set(ENTITY_TYPES);
export const LIFECYCLE_ENTITY_TYPE_SET: ReadonlySet<LifecycleEntityType> =
  new Set(LIFECYCLE_ENTITY_TYPES);
export const MISSION_CONTROL_NODE_TYPE_SET: ReadonlySet<MissionControlNodeType> =
  new Set(MISSION_CONTROL_NODE_TYPES);
export const VERIFIABLE_COMPLETION_ENTITY_TYPE_SET: ReadonlySet<VerifiableCompletionEntityType> =
  new Set(VERIFIABLE_COMPLETION_ENTITY_TYPES);

export function normalizeEntityType(value: unknown): EntityType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (!normalized) return null;
  return ENTITY_TYPE_SET.has(normalized as EntityType)
    ? (normalized as EntityType)
    : null;
}

export function isEntityType(value: unknown): value is EntityType {
  return normalizeEntityType(value) !== null;
}

export function isLifecycleEntityType(
  value: unknown
): value is LifecycleEntityType {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  return LIFECYCLE_ENTITY_TYPE_SET.has(normalized as LifecycleEntityType);
}
