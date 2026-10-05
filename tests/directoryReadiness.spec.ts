import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getKnownToolContract } from '../src/contractTools';
import { CLAUDE_DIRECTORY_TOOL_ADAPTERS, getClaudeDirectoryToolContract } from '../src/claudeDirectoryTools';
import { CLAUDE_DIRECTORY_TOOL_DESCRIPTIONS } from '../src/claudeDirectoryToolMetadata';
import {
  CLAUDE_DIRECTORY_SURFACE,
  resolveProfileToolSet,
} from '../src/toolProfiles';
import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';

function selectedRouterNames() {
  return [...(resolveProfileToolSet('claude-directory') ?? [])].filter((id) => ['orgx_write', 'orgx_act', 'orgx_plan', 'orgx_spawn', 'orgx_decide'].includes(id));
}

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
const anthropicDirectoryDoc = readFileSync(
  resolve(root, 'docs/anthropic-directory.md'),
  'utf8'
);
const anthropicSubmissionForm = readFileSync(
  resolve(root, 'docs/anthropic-submission-form.md'),
  'utf8'
);

describe('Anthropic directory readiness', () => {
  it('covers every submitted tool with a narrow description of its own function', () => {
    expect(Object.keys(CLAUDE_DIRECTORY_TOOL_DESCRIPTIONS).sort()).toEqual([...CLAUDE_DIRECTORY_SURFACE].sort());
    for (const [name, description] of Object.entries(CLAUDE_DIRECTORY_TOOL_DESCRIPTIONS)) {
      expect(description.length, name).toBeGreaterThan(0);
      expect(description, name).not.toMatch(/NEXT:|DO NOT USE|USE WHEN:|https?:\/\//i);
      for (const otherTool of CLAUDE_DIRECTORY_SURFACE) {
        if (otherTool !== name) expect(description, name).not.toContain(otherTool);
      }
    }
  });
  it('includes reviewer-facing docs and README sections', () => {
    const requiredDocs = [
      'docs/privacy-policy.md',
      'docs/security-data-handling.md',
      'docs/support.md',
      'docs/openai-review-runbook.md',
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
    expect(serverJson.title).toBe('OrgX MCP — Organizational Continuity for AI Agents');
    expect(serverJson.description).toContain(
      'Make AI work resumable, reviewable, and provable across agents.'
    );
    // The MCP Registry rejects a description over 100 characters (422 on
    // body.description), which failed the v1.1.5 registry publish.
    expect(serverJson.description?.length ?? 0).toBeLessThanOrEqual(100);
    expect(serverJson.remotes).toEqual([
      { type: 'streamable-http', url: 'https://mcp.useorgx.com/mcp' },
      { type: 'sse', url: 'https://mcp.useorgx.com/sse' },
    ]);
    const toolNames = serverJson.tools?.map((tool) => tool.name).filter(Boolean);
    expect(toolNames).toEqual([
      'orgx_bootstrap',
      'orgx_tail',
      'orgx_search',
      'orgx_inspect',
      'orgx_controller_status',
      'orgx_recommend',
      'orgx_write',
      'orgx_attach',
      'orgx_act',
      'manage_lifecycle',
      'orgx_plan',
      'orgx_spawn',
      'orgx_decide',
      'orgx_expect',
      'orgx_submit_receipt',
      'orgx_emit_activity',
      'orgx_request_attention',
      'orgx_poll_attention',
      'orgx_ack_attention',
      'orgx_request_question',
      'orgx_poll_question',
      'orgx_emit_execution_graph',
      'approve_decision',
      'reject_decision',
      'orgx_widget_decide',
      'orgx_command_status',
      'orgx_panel_snapshot',
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
      'get_operator_chronicle',
      'check_execution_readiness',
      'consolidate_pr',
      'request_independent_artifact_review',
      'resume_agent_run',
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

  it('documents the broader operation-specific Anthropic endpoint', () => {
    const endpoint = 'https://mcp.useorgx.com/mcp?profile=claude-directory';
    const selectedTools = resolveProfileToolSet('claude-directory');
    expect([...(selectedTools ?? [])]).toEqual([...CLAUDE_DIRECTORY_SURFACE]);
    expect(selectedTools?.size).toBe(29);
    expect(selectedTools?.has('orgx_bootstrap')).toBe(true);
    expect(anthropicDirectoryDoc).toContain(endpoint);
    expect(anthropicSubmissionForm).toContain(endpoint);
    expect(anthropicDirectoryDoc).toContain('Usage accounting is still a state change');
    expect(anthropicDirectoryDoc).toContain('endpoint is not\nstateless');
    expect(anthropicSubmissionForm).toContain('29 captured tools');
    expect(anthropicSubmissionForm).not.toContain('[ fill before submitting:');
    for (const toolName of selectedTools ?? []) {
      const contract = getClaudeDirectoryToolContract(toolName) ?? getKnownToolContract(toolName);
      expect(contract, toolName).toBeDefined();
      expect(contract?.securitySchemes, toolName).toBeDefined();
      expect(contract?.annotations, toolName).toEqual({
        readOnlyHint: expect.any(Boolean), destructiveHint: expect.any(Boolean), openWorldHint: expect.any(Boolean),
      });
      expect(anthropicDirectoryDoc, toolName).toContain('`' + toolName + '`');
    }
  });

  it('separates reads from writes and prevents arbitrary router actions', () => {
    const byId = new Map(CLAUDE_DIRECTORY_TOOL_ADAPTERS.map((tool) => [tool.id, tool]));
    for (const id of ['orgx_read_plan', 'orgx_check_delegation', 'orgx_list_pending_decisions', 'orgx_open_decision_review']) {
      expect(byId.get(id)?.annotations.readOnlyHint, id).toBe(true);
    }
    for (const id of ['orgx_create_entity', 'orgx_update_entity', 'orgx_start_plan', 'orgx_delegate_work', 'orgx_record_decision', 'orgx_complete_with_proof']) {
      expect(byId.get(id)?.annotations.readOnlyHint, id).toBe(false);
    }
    expect(selectedRouterNames()).toEqual([]);
    expect(byId.get('orgx_read_plan')?.toCanonicalArgs({ action: 'complete' }).action).toBe('resume');
    expect(byId.get('orgx_complete_with_proof')?.toCanonicalArgs({ action: 'delete' }).action).toBe('complete_with_proof');
  });

  it('excludes synthetic screenshot artifacts from submission evidence', () => {
    const removedEvidence = [
      'public/screenshots/anthropic-memory-search-response.png',
      'public/screenshots/anthropic-agent-status-response.png',
      'public/screenshots/anthropic-initiative-pulse-response.png',
      'public/screenshots/anthropic-morning-brief-response.png',
      'scripts/render-anthropic-review-screenshots.mjs',
    ];

    for (const path of removedEvidence) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }
    expect(packageJson.scripts?.['screenshots:anthropic']).toBeUndefined();
    expect(anthropicSubmissionForm).toContain(
      'pending authenticated post-deploy capture'
    );
    expect(anthropicSubmissionForm).toMatch(
      /Local\s+fixtures, synthetic renders, and generic demo images are not submission\s+evidence/
    );
    expect(anthropicSubmissionForm).toContain('3–5 PNG files');
    expect(anthropicSubmissionForm).toContain('at least 1000 px wide');
    expect(anthropicSubmissionForm).toMatch(/Claude app\s+response only/);
    expect(anthropicSubmissionForm).toContain('Video and GIF files');
    expect(anthropicSubmissionForm).not.toContain(
      'anthropic-memory-search-response.png'
    );
  });

  it('applies profile-aware prompt and resource discovery in the worker', () => {
    expect(indexSource).toContain(
      'resolveProfileDiscoveryPolicy(this.props?.profile)'
    );
    expect(indexSource).toContain(
      'this.registerWidgetResources(discoveryPolicy.widgetUris)'
    );
    expect(indexSource).toContain(
      'if (!discoveryPolicy.includePrompts) return;'
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
      destructive: boolean,
      openWorld = false
    ) => {
      const registrationPattern =
        toolId === 'scaffold_initiative' || toolId === 'review_artifact'
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
      expect(snippet).toContain(`openWorldHint: ${openWorld}`);
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
    expectSnippetAnnotations('review_artifact', true, false);
    expectSnippetAnnotations('scaffold_initiative', false, true, true);
    expectSnippetAnnotations('get_task_with_context', true, false);
    expectSnippetAnnotations('batch_delete_entities', false, true);
    expectSnippetAnnotations('update_entity', false, true);
    expectSnippetAnnotations('configure_org', false, true);
    expectSnippetAnnotations('stats', true, false);
    expectSnippetAnnotations('workspace', false, true);
  });
});
