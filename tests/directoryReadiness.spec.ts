import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import {
  CLAUDE_DIRECTORY_SURFACE,
  resolveProfileToolSet,
} from '../src/toolProfiles';
import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';

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

  it('documents and locks the focused non-destructive Anthropic review endpoint', () => {
    const endpoint =
      'https://mcp.useorgx.com/mcp?profile=claude-directory';
    const selectedTools = resolveProfileToolSet('claude-directory');

    expect([...(selectedTools ?? [])]).toEqual([
      ...CLAUDE_DIRECTORY_SURFACE,
    ]);
    expect(selectedTools?.size).toBe(7);
    expect(selectedTools?.has('orgx_bootstrap')).toBe(false);
    expect(anthropicDirectoryDoc).toContain(endpoint);
    expect(anthropicSubmissionForm).toContain(endpoint);
    expect(anthropicDirectoryDoc).toContain(
      'Three tools are\nstrictly read-only'
    );
    expect(anthropicDirectoryDoc).toContain(
      'Four tools advertise `readOnlyHint: false`'
    );
    expect(anthropicDirectoryDoc).toContain(
      'usage accounting is still a state change'
    );
    expect(anthropicDirectoryDoc).toContain('the endpoint is not stateless');
    expect(anthropicSubmissionForm).toContain(
      '3 strictly read-only and 4 that record metered MCP allowance usage'
    );
    expect(anthropicSubmissionForm).not.toContain(
      '[ fill before submitting:'
    );

    const manifestTools = new Map(
      (serverJson.tools ?? []).map((tool) => [tool.name, tool])
    );
    const registeredDefinitions = new Map(
      [
        ...CONTRACT_TOOL_DEFINITIONS,
        ...CHATGPT_TOOL_DEFINITIONS,
        ...CLIENT_INTEGRATION_TOOL_DEFINITIONS,
      ].map((tool) => [tool.id, tool])
    );
    const unavailableGuidance =
      /\b(?:entity_action|list_entities|get_org_snapshot|approve_decision|orgx_act|orgx_write|orgx_spawn)\b/;

    const readOnlyByTool = new Map<string, boolean>([
      ['orgx_search', false],
      ['orgx_inspect', true],
      ['orgx_recommend', false],
      ['get_agent_status', false],
      ['get_initiative_pulse', false],
      ['get_morning_brief', true],
      ['get_operator_chronicle', true],
    ]);

    for (const toolName of selectedTools ?? []) {
      const manifestTool = manifestTools.get(toolName);
      expect(manifestTool?.annotations).toEqual({
        readOnlyHint: readOnlyByTool.get(toolName),
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(
        manifestTool?.description,
        `${toolName} manifest points at an unavailable directory tool`
      ).not.toMatch(unavailableGuidance);

      const registeredDefinition = registeredDefinitions.get(toolName);
      if (registeredDefinition) {
        expect(
          registeredDefinition.description,
          `${toolName} live description points at an unavailable directory tool`
        ).not.toMatch(unavailableGuidance);
      }
    }
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
