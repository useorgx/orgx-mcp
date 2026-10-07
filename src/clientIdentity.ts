import marks from './clientBrandAssets.json';

const clients: Record<string, { label: string; mark?: keyof typeof marks }> = {
  'claude-code': { label: 'Claude Code', mark: 'claude' },
  claude: { label: 'Claude', mark: 'claude' },
  codex: { label: 'Codex', mark: 'openai' },
  chatgpt: { label: 'ChatGPT', mark: 'openai' },
  cursor: { label: 'Cursor', mark: 'cursor' },
  opencode: { label: 'OpenCode' }, openclaw: { label: 'OpenClaw' },
  copilot: { label: 'GitHub Copilot' }, vscode: { label: 'VS Code' },
  gemini: { label: 'Gemini' }, cline: { label: 'Cline' }, goose: { label: 'Goose' },
  'web-ui': { label: 'OrgX' }, api: { label: 'API client' },
};

// Provenance only: never infer a client from its model, prose, or current host.
export function clientIdentity(value: unknown): { label: string; mark: string } {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const client = Object.hasOwn(clients, slug) ? clients[slug] : undefined;
  return { label: client?.label ?? (slug ? 'Other client' : 'Client not reported'),
    mark: client?.mark ? marks[client.mark] : '' };
}
