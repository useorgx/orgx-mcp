export const NEW_SESSION_WELCOME_STORAGE_PREFIX =
  'mcp:new_session_welcome:v1:user';

export const NEW_SESSION_WELCOME_STORAGE_TTL_SECONDS = 60 * 60 * 24 * 365;

export function buildNewSessionWelcomeStorageKey(
  userId: string | null | undefined
): string | null {
  const normalized = userId?.trim();
  if (!normalized) return null;

  return `${NEW_SESSION_WELCOME_STORAGE_PREFIX}:${encodeURIComponent(
    normalized
  )}`;
}

export function buildNewSessionWelcomeText(): string {
  return [
    'Connected to OrgX.',
    'Start with `scaffold_initiative`, `list_entities`, `get_org_snapshot`, or `recommend_next_action`.',
  ].join(' ');
}
