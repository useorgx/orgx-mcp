export function buildNewSessionWelcomeText(): string {
  return [
    'Connected to OrgX.',
    'Start with `scaffold_initiative`, `list_entities`, `get_org_snapshot`, or `recommend_next_action`.',
  ].join(' ');
}
