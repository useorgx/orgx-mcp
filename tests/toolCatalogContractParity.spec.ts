import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  CONTRACT_TOOL_DEFINITIONS,
  INLINE_TOOL_CONTRACTS,
} from '../src/contractTools';
import { TOOL_PROFILES } from '../src/toolProfiles';
import { getPublicOperationContract } from '../src/publicOperationContracts';
import { WORKFLOW_TOOL_ADAPTERS } from '../src/workflowTools';
import { RECEIPT_OPERATION_TOOLS } from '../src/receiptOperationTools';
import { WIDGET_OPERATION_TOOLS } from '../src/widgetOperations';
import { CLAUDE_DIRECTORY_TOOL_ADAPTERS } from '../src/claudeDirectoryTools';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(
  readFileSync(resolve(root, 'docs/generated/tool-catalog.json'), 'utf8')
) as {
  tools: Array<{
    id: string;
    securityScopes: string[];
    readOnly: boolean;
    source: string;
    profiles: string[];
    securitySchemes?: unknown;
    annotations?: unknown;
    inputSchema?: Record<string, unknown>;
    profileContracts?: Record<string, { inputSchema: Record<string, unknown>; securitySchemes?: unknown; annotations?: unknown }>;
  }>;
};

function extractScopes(
  schemes: readonly { type: string; scopes?: readonly string[] }[]
): string[] {
  return schemes.flatMap((scheme) => [...(scheme.scopes ?? [])]);
}

function expectedProfiles(toolId: string): string[] {
  return Object.entries(TOOL_PROFILES)
    .filter(([name, profile]) => {
      if (name === 'full') return false;
      return profile.tools === null || profile.tools.includes(toolId);
    })
    .map(([name]) => name);
}

describe('generated tool catalog contract parity', () => {
  it('keeps controller status aligned with its read-only contract and canary profiles', () => {
    const source = CONTRACT_TOOL_DEFINITIONS.find(
      (tool) => tool.id === 'orgx_controller_status'
    )!;
    const generated = catalog.tools.find((tool) => tool.id === source.id);

    expect(generated).toEqual(
      expect.objectContaining({
        id: source.id,
        securityScopes: extractScopes(source.securitySchemes),
        readOnly: source.annotations.readOnlyHint,
        source: 'contract',
        profiles: expectedProfiles(source.id),
      })
    );
    expect(generated?.securityScopes).toEqual([
      'decisions:read',
      'initiatives:read',
    ]);
    expect(generated?.readOnly).toBe(true);
    expect(generated?.profiles).toEqual(['legacy', 'claude-plugin']);
  });

  it('keeps review_artifact aligned with its registered inline contract', () => {
    const source = INLINE_TOOL_CONTRACTS.review_artifact;
    const generated = catalog.tools.find((tool) => tool.id === source.id);

    expect(generated).toEqual(
      expect.objectContaining({
        id: source.id,
        securityScopes: extractScopes(source.securitySchemes),
        readOnly: source.annotations.readOnlyHint,
        source: 'inline',
        profiles: expectedProfiles(source.id),
      })
    );
    expect(generated?.securityScopes).toEqual(['initiatives:read']);
    expect(generated?.readOnly).toBe(true);
    expect(generated?.profiles).toContain('legacy');
    expect(generated?.profiles).not.toContain('chatgpt');
    expect(generated?.profiles).not.toContain('memory');
  });

  it('documents every current operation with its exact schema and authorization profile', () => {
    const sourceGroups = [
      { definitions: WORKFLOW_TOOL_ADAPTERS, source: 'workflow_operation' },
      { definitions: RECEIPT_OPERATION_TOOLS, source: 'receipt_operation' },
      { definitions: WIDGET_OPERATION_TOOLS, source: 'widget_operation' },
    ];
    for (const { definitions, source } of sourceGroups) {
      for (const definition of definitions) {
        const generated = catalog.tools.find((tool) => tool.id === definition.id);
        expect(generated, definition.id).toMatchObject({
          id: definition.id,
          source,
          readOnly: definition.annotations.readOnlyHint,
          securitySchemes: definition.securitySchemes,
          annotations: definition.annotations,
          profiles: expectedProfiles(definition.id),
        });
        expect(generated?.profiles, definition.id).toContain('chatgpt');
      }
    }
    expect(catalog.tools.find((tool) => tool.id === 'orgx_open_artifact_review')?.profiles).toContain('chatgpt');
  });

  it('retains the actual legacy-directory schema when a current operation reuses its ID', () => {
    for (const source of CLAUDE_DIRECTORY_TOOL_ADAPTERS) {
      if (!WORKFLOW_TOOL_ADAPTERS.some((tool) => tool.id === source.id) && source.id !== 'orgx_record_plan_edit') continue;
      const generated = catalog.tools.find((tool) => tool.id === source.id)!;
      expect(generated.profileContracts?.['claude-directory-legacy'], source.id).toMatchObject({
        inputSchema: zodToJsonSchema(z.object(source.inputSchema)),
        securitySchemes: source.securitySchemes,
        annotations: source.annotations,
      });
    }
    const plan = catalog.tools.find((tool) => tool.id === 'orgx_start_plan')!;
    expect(plan.inputSchema?.required).toEqual(['title']);
    expect(plan.profileContracts?.['claude-directory-legacy'].inputSchema.required).toEqual(['feature_name']);
    const review = catalog.tools.find((tool) => tool.id === 'orgx_open_decision_review')!;
    expect(review.inputSchema?.properties).not.toHaveProperty('action');
    expect(review.profileContracts?.['claude-directory-legacy'].inputSchema.properties).toHaveProperty('action');
  });
});


it('publishes the complete security and safety contract for every default descriptor, including app callbacks and local validation', () => {
  for (const id of TOOL_PROFILES.v2.tools!) {
    const contract = getPublicOperationContract(id)!;
    const generated = catalog.tools.find((tool) => tool.id === id)!;
    expect(generated.securitySchemes, id).toEqual(contract.securitySchemes);
    expect(generated.annotations, id).toEqual(contract.annotations);
  }
});
