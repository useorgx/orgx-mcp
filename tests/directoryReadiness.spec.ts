import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const serverJson = JSON.parse(
  readFileSync(resolve(root, 'server.json'), 'utf8')
) as {
  websiteUrl?: string;
  title?: string;
  description?: string;
  remotes?: Array<{ type?: string; url?: string }>;
  tools?: Array<{
    name?: string;
    title?: string;
    description?: string;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      openWorldHint?: boolean;
    };
  }>;
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
      'docs/anthropic-reviewer-runbook.md',
      'docs/anthropic-release-manager-checklist.md',
    ];

    const requiredReadmeSections = [
      '## What OrgX MCP Does',
      '## Directory Quick Links',
      '## Authentication For Reviewers',
      '## Reviewer Operations',
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
    expect(serverJson.title).toBe('OrgX MCP — Organizational Memory for AI Agents');
    expect(serverJson.description).toContain('Organizational memory');
    expect(serverJson.remotes).toEqual([
      { type: 'streamable-http', url: 'https://mcp.useorgx.com/mcp' },
      { type: 'sse', url: 'https://mcp.useorgx.com/sse' },
    ]);
    const toolNames = serverJson.tools?.map((tool) => tool.name).filter(Boolean);
    expect(toolNames).toEqual([
      'orgx_bootstrap',
      'orgx_search',
      'orgx_inspect',
      'orgx_recommend',
      'orgx_write',
      'orgx_attach',
      'orgx_act',
      'orgx_plan',
      'orgx_spawn',
      'orgx_decide',
      'orgx_submit_receipt',
      'orgx_emit_activity',
      'approve_decision',
      'reject_decision',
      'get_agent_status',
      'get_initiative_pulse',
      'scaffold_initiative',
      'spawn_agent_task',
      'handoff_task',
      'recommend_next_action',
      'query_org_memory',
      'recall_memory',
      'approve_agent_work',
      'delegate_agent_task',
      'track_project_progress',
      'review_artifact',
      'get_morning_brief',
      'consolidate_pr',
    ]);
    expect(serverJson.tools?.find((tool) => tool.name === 'orgx_bootstrap')?.description).toContain(
      'v2 routing guidance'
    );
  });

  it('publishes reviewer-facing tool titles and annotations in server.json', () => {
    expect(serverJson.tools?.length).toBeGreaterThan(0);

    for (const tool of serverJson.tools ?? []) {
      expect(tool.title, `${tool.name} is missing a title`).toEqual(
        expect.any(String)
      );
      expect(tool.annotations, `${tool.name} is missing annotations`).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
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
    expectSnippetAnnotations('verify_entity_completion', true, false);
    expectSnippetAnnotations('create_entity', false, false);
    expectSnippetAnnotations('batch_create_entities', false, false);
    expectSnippetAnnotations('scaffold_initiative', false, false);
    expectSnippetAnnotations('get_task_with_context', true, false);
    expectSnippetAnnotations('batch_delete_entities', false, true);
    expectSnippetAnnotations('update_entity', false, true);
    expectSnippetAnnotations('configure_org', false, true);
    expectSnippetAnnotations('stats', true, false);
    expectSnippetAnnotations('workspace', false, true);
  });
});
