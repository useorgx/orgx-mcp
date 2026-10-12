/** Canonical domain vocabulary with the existing MCP workspace route extension. */
export * from '../generated/entityVocabulary';
import {
  LIFECYCLE_ENTITY_TYPES as DOMAIN_LIFECYCLE_ENTITY_TYPES,
  normalizeEntityType,
} from '../generated/entityVocabulary';

// Workspace lifecycle routing is an MCP presentation/operation capability.
// It does not add workspace to OrgX's domain lifecycle or authorize a mutation.
export const LIFECYCLE_ENTITY_TYPES = [
  'workspace',
  ...DOMAIN_LIFECYCLE_ENTITY_TYPES,
] as const;
export type LifecycleEntityType = (typeof LIFECYCLE_ENTITY_TYPES)[number];
export const LIFECYCLE_ENTITY_TYPE_SET: ReadonlySet<LifecycleEntityType> =
  new Set(LIFECYCLE_ENTITY_TYPES);

export function isLifecycleEntityType(value: unknown): value is LifecycleEntityType {
  const normalized = normalizeEntityType(value);
  return normalized !== null && LIFECYCLE_ENTITY_TYPE_SET.has(normalized as LifecycleEntityType);
}
