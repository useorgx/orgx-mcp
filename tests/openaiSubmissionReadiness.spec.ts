import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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

const serverToolsByName = new Map(
  serverJson.tools.map((tool) => [tool.name, tool])
);

describe('OpenAI ChatGPT app submission readiness', () => {
  it('keeps app info concise and review-facing', () => {
    expect(submission.app_info.display_name).toBe('OrgX');
    expect(submission.app_info.subtitle.length).toBeLessThanOrEqual(30);
    expect(submission.app_info.description).toContain('organizational memory');
    expect(submission.app_info.category).toBe('PRODUCTIVITY');
  });

  it('covers every server.json tool with matching explicit annotations', () => {
    expect(Object.keys(submission.tools).sort()).toEqual(
      serverJson.tools.map((tool) => tool.name).sort()
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
