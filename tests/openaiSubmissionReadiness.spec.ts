import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CHATGPT_PUBLIC_SURFACE } from '../src/toolProfiles';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const submission = JSON.parse(
  readFileSync(resolve(root, 'chatgpt-app-submission.json'), 'utf8')
) as {
  app_info: {
    display_name: string;
    subtitle: string;
    description: string;
    category: string;
  };
  tools: Record<
    string,
    {
      annotations: {
        readOnlyHint: boolean;
        openWorldHint: boolean;
        destructiveHint: boolean;
      };
      justifications: Record<string, string>;
    }
  >;
  test_cases: Array<{
    user_prompt: string;
    tools_triggered: string | null;
    expected_output: string;
  }>;
  negative_test_cases: Array<{
    user_prompt: string;
    tools_triggered: string | null;
    expected_output: string;
  }>;
};

const serverJson = JSON.parse(
  readFileSync(resolve(root, 'server.json'), 'utf8')
) as {
  tools: Array<{
    name: string;
    annotations: {
      readOnlyHint: boolean;
      openWorldHint: boolean;
      destructiveHint: boolean;
    };
  }>;
};

const privacyPolicy = readFileSync(
  resolve(root, 'docs/privacy-policy.md'),
  'utf8'
);
const openaiRunbook = readFileSync(
  resolve(root, 'docs/openai-review-runbook.md'),
  'utf8'
);
const contractToolsSource = readFileSync(
  resolve(root, 'src/contractTools.ts'),
  'utf8'
);
const workerSource = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
const scaffoldControlSource = readFileSync(
  resolve(root, 'src/scaffoldControl.ts'),
  'utf8'
);

type ToolHints = {
  readOnlyHint: boolean;
  openWorldHint: boolean;
  destructiveHint: boolean;
};

const expectedChatGptHints = {
  orgx_bootstrap: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  orgx_search: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  orgx_inspect: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  orgx_recommend: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  orgx_write: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  orgx_attach: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  orgx_act: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  manage_lifecycle: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  orgx_plan: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  orgx_spawn: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  orgx_decide: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  orgx_submit_receipt: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  approve_decision: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  reject_decision: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  get_agent_status: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  get_initiative_pulse: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  scaffold_initiative: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  handoff_task: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  approve_agent_work: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  review_artifact: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  get_morning_brief: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  get_operator_chronicle: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  check_execution_readiness: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
} satisfies Record<(typeof CHATGPT_PUBLIC_SURFACE)[number], ToolHints>;

const serverToolsByName = new Map(
  serverJson.tools.map((tool) => [tool.name, tool])
);

describe('OpenAI ChatGPT app submission readiness', () => {
  it('keeps app info concise and review-facing', () => {
    expect(submission.app_info.display_name).toBe('OrgX');
    expect(submission.app_info.subtitle.length).toBeLessThanOrEqual(30);
    expect(submission.app_info.description).toContain(
      'Organizational continuity for AI agents'
    );
    expect(submission.app_info.description).toContain(
      'Make AI work resumable, reviewable, and provable across agents.'
    );
    expect(submission.app_info.category).toBe('PRODUCTIVITY');
  });

  it('covers every ChatGPT profile tool with matching explicit annotations', () => {
    expect(Object.keys(submission.tools).sort()).toEqual(
      [...CHATGPT_PUBLIC_SURFACE].sort()
    );

    for (const [toolName, submitted] of Object.entries(submission.tools)) {
      const serverTool = serverToolsByName.get(toolName);
      expect(serverTool, `Missing server.json tool: ${toolName}`).toBeDefined();
      expect(submitted.annotations, `${toolName} annotation drift`).toEqual(
        serverTool?.annotations
      );
      expect(Object.values(submitted.justifications)).toHaveLength(3);
      for (const justification of Object.values(submitted.justifications)) {
        expect(justification, `${toolName} has an empty justification`).toEqual(
          expect.any(String)
        );
        expect(justification.trim().length).toBeGreaterThan(20);
      }
    }
  });

  it('keeps the reviewed 23-tool risk matrix explicit and fail-closed', () => {
    expect(Object.keys(expectedChatGptHints).sort()).toEqual(
      [...CHATGPT_PUBLIC_SURFACE].sort()
    );

    for (const [toolName, expectedHints] of Object.entries(
      expectedChatGptHints
    )) {
      expect(submission.tools[toolName]?.annotations, toolName).toEqual(
        expectedHints
      );
      expect(serverToolsByName.get(toolName)?.annotations, toolName).toEqual(
        expectedHints
      );
    }
  });

  it('ties elevated hints to implemented overwrite, dispatch, approval, and external-sync modes', () => {
    expect(contractToolsSource).toContain(
      "live_visibility: z.enum(['private', 'public'])"
    );
    expect(workerSource).toContain("if (operation === 'update')");
    expect(workerSource).toContain('buildEntityUpdateRequest({');
    expect(workerSource).toContain(
      "`/api/entities/${args.type}/${args.id}/${resolvedAction}`"
    );
    expect(workerSource).toContain("case 'approve_agent_work':");
    expect(workerSource).toContain("'approve_decision'");
    expect(workerSource).toContain(
      'which handles MCP context, stream continuation, and agent resumption.'
    );
    expect(scaffoldControlSource).toContain(
      "const mode = legacyLaunch === false ? 'scaffold' : 'launch';"
    );
    expect(workerSource).toContain("'/api/integrations/work-graph/mirror'");
  });

  it('does not submit internal transports, redundant aliases, or PR consolidation', () => {
    const submittedTools = new Set(Object.keys(submission.tools));
    const excludedTools = [
      'orgx_emit_activity',
      'orgx_request_attention',
      'orgx_poll_attention',
      'orgx_ack_attention',
      'orgx_request_question',
      'orgx_poll_question',
      'orgx_emit_execution_graph',
      'query_org_memory',
      'recall_memory',
      'recommend_next_action',
      'track_project_progress',
      'delegate_agent_task',
      'spawn_agent_task',
      'consolidate_pr',
    ];

    for (const toolName of excludedTools) {
      expect(submittedTools.has(toolName), `${toolName} should be excluded`).toBe(
        false
      );
    }
  });

  it('submits deterministic positive and negative test cases', () => {
    expect(submission.test_cases).toHaveLength(5);
    expect(submission.negative_test_cases).toHaveLength(3);

    for (const testCase of submission.test_cases) {
      expect(testCase.tools_triggered, testCase.user_prompt).toEqual(
        expect.any(String)
      );
      expect(
        serverToolsByName.has(testCase.tools_triggered as string),
        `${testCase.user_prompt} references missing tool ${testCase.tools_triggered}`
      ).toBe(true);
      expect(testCase.expected_output.length).toBeGreaterThan(60);
      expect(openaiRunbook).toContain(testCase.user_prompt);
      expect(openaiRunbook).toContain(testCase.tools_triggered as string);
    }

    for (const testCase of submission.negative_test_cases) {
      expect(testCase.tools_triggered).toBeNull();
      expect(testCase.expected_output).toMatch(/should not|must not|refuse/i);
      expect(openaiRunbook).toContain(testCase.user_prompt);
    }
  });

  it('documents web, mobile, and output privacy verification for reviewers', () => {
    const requiredRunbookPhrases = [
      'ChatGPT web',
      'ChatGPT mobile',
      'same seeded workspace baseline',
      'tool responses',
      'nested widget payloads',
      'raw access tokens',
      'internal request IDs',
      'Do not mark the app ready for resubmission',
    ];

    for (const phrase of requiredRunbookPhrases) {
      expect(openaiRunbook).toContain(phrase);
    }
  });

  it('documents the optional fail-closed OpenAI domain challenge binding', () => {
    const requiredRunbookPhrases = [
      '/.well-known/openai-apps-challenge',
      'OPENAI_APPS_CHALLENGE_TOKEN',
      '404',
      'no-store',
      'portal issues a new challenge',
    ];

    for (const phrase of requiredRunbookPhrases) {
      expect(openaiRunbook).toContain(phrase);
    }
  });

  it('publishes complete privacy disclosures for current tool inputs and outputs', () => {
    const requiredPolicyPhrases = [
      'Tool inputs',
      'Tool outputs',
      'OAuth and MCP session data',
      'Operational telemetry',
      'Data Recipients And Processors',
      'OpenAI',
      'ChatGPT',
      'Retention',
      'User Controls',
      'access tokens',
      'refresh tokens',
      'workspace',
      'decisions',
      'initiatives',
      'agent',
      'artifacts',
      'GitHub pull request URLs',
      'We do not sell',
    ];

    for (const phrase of requiredPolicyPhrases) {
      expect(privacyPolicy).toContain(phrase);
    }
  });
});
