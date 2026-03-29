import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const serverJson = JSON.parse(
  readFileSync(resolve(root, 'server.json'), 'utf8')
) as {
  websiteUrl?: string;
  title?: string;
  description?: string;
  tools?: Array<{ name?: string; description?: string }>;
};
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8')
) as {
  scripts?: Record<string, string>;
};
const indexSource = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
const toolDefinitionsSource = readFileSync(
  resolve(root, 'src/toolDefinitions.ts'),
  'utf8'
);

describe('Anthropic directory readiness', () => {
  it('includes reviewer-facing docs and README sections', () => {
    const requiredDocs = [
      'docs/privacy-policy.md',
      'docs/security-data-handling.md',
      'docs/support.md',
      'docs/anthropic-directory.md',
    ];

    const requiredReadmeSections = [
      '## What OrgX MCP Does',
      '## Directory Quick Links',
      '## Authentication For Reviewers',
      '## Examples',
      '## Privacy Policy',
      '## Support',
      '## Security & Data Handling',
      '## Anthropic Directory Review',
      '## Limitations',
    ];

    for (const docPath of requiredDocs) {
      expect(existsSync(resolve(root, docPath)), `Missing doc: ${docPath}`).toBe(
        true
      );
    }

    for (const heading of requiredReadmeSections) {
      expect(readme).toContain(heading);
    }
  });

  it('adds a directory preflight script and user-facing server metadata', () => {
    expect(packageJson.scripts?.['directory:preflight']).toBe(
      'node scripts/directory-preflight.mjs'
    );
    expect(serverJson.websiteUrl).toBe('https://useorgx.com');
    expect(serverJson.title).toBe('OrgX MCP');
    expect(serverJson.description).toContain('Agent orchestration');
    expect(serverJson.tools?.find((tool) => tool.name === 'account_upgrade')?.description).toContain(
      'Does not charge automatically.'
    );
  });

  it('marks high-risk shared tool definitions as destructive where appropriate', () => {
    const destructiveTools = [
      'approve_decision',
      'reject_decision',
      'spawn_agent_task',
      'handoff_task',
      'scoring_config',
      'queue_action',
      'workspace',
      'configure_org',
    ];

    for (const toolId of destructiveTools) {
      expect(toolDefinitionsSource).toMatch(
        new RegExp(
          `id:\\s*'${toolId}'[\\s\\S]*?annotations:\\s*\\{\\s*readOnlyHint:\\s*false,\\s*destructiveHint:\\s*true,\\s*openWorldHint:\\s*(?:false|true)\\s*\\}`,
          'm'
        )
      );
    }
  });

  it('marks audited inline registrations with explicit annotations', () => {
    const expectSnippetAnnotations = (
      toolId: string,
      readOnly: boolean,
      destructive: boolean
    ) => {
      const registrationPattern =
        toolId === 'scaffold_initiative'
          ? new RegExp(
              `registerAppTool\\(\\s*this\\.server,\\s*'${toolId}'`,
              'm'
            )
          : new RegExp(`registerTool\\(\\s*'${toolId}'`, 'm');
      const match = registrationPattern.exec(indexSource);
      expect(match, `Missing tool registration snippet for ${toolId}`).not.toBeNull();
      const start = match!.index;
      const snippet = indexSource.slice(start, start + 6000);
      expect(snippet).toContain('annotations: {');
      expect(snippet).toContain(`readOnlyHint: ${readOnly}`);
      expect(snippet).toContain(`destructiveHint: ${destructive}`);
      expect(snippet).toContain('openWorldHint: false');
    };

    expectSnippetAnnotations('get_org_snapshot', true, false);
    expectSnippetAnnotations('account_status', true, false);
    expectSnippetAnnotations('account_upgrade', false, true);
    expectSnippetAnnotations('account_usage_report', true, false);
    expectSnippetAnnotations('list_entities', true, false);
    expectSnippetAnnotations('entity_action', false, true);
    expectSnippetAnnotations('create_entity', false, true);
    expectSnippetAnnotations('batch_create_entities', false, true);
    expectSnippetAnnotations('scaffold_initiative', false, true);
    expectSnippetAnnotations('get_task_with_context', true, false);
    expectSnippetAnnotations('batch_delete_entities', false, true);
    expectSnippetAnnotations('update_entity', false, true);
    expectSnippetAnnotations('configure_org', false, true);
    expectSnippetAnnotations('stats', true, false);
    expectSnippetAnnotations('workspace', false, true);
  });
});
