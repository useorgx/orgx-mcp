import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  CONTRACT_TOOL_DEFINITIONS,
  getKnownToolContract,
  getKnownToolContracts,
} from '../src/contractTools';
import {
  CLIENT_CONTEXT_SCHEMA,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  ENTITY_TYPES,
} from '../src/toolDefinitions';

function collectInlineRegisteredToolIds(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexPath = resolvePath(here, '..', 'src', 'index.ts');
  const src = readFileSync(indexPath, 'utf8');
  const ids = new Set<string>();
  const inlineRe = /this\.server\.registerTool\(\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  const appRe = /registerAppTool\(\s*this\.server,\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = inlineRe.exec(src))) ids.add(match[1]!);
  while ((match = appRe.exec(src))) ids.add(match[1]!);

  return [...ids].sort();
}

describe('contract tool catalog', () => {
  it('accepts partial client conversation context without requiring a client-specific id', () => {
    expect(() =>
      CLIENT_CONTEXT_SCHEMA.parse({
        client: { name: 'chatgpt' },
        conversation: { title: 'Reviewer smoke test' },
      })
    ).not.toThrow();
  });

  it('includes bootstrap, describe, and wrapper tools', () => {
    const ids = CONTRACT_TOOL_DEFINITIONS.map((tool) => tool.id);
    expect(ids).toContain('orgx_bootstrap');
    expect(ids).toContain('orgx_describe_tool');
    expect(ids).toContain('resume_plan_session');
    expect(ids).toContain('create_task');
    expect(ids).toContain('validate_studio_content');
    expect(ids).toContain('pin_workstream');
  });

  it('can resolve known tools from the runtime catalog', () => {
    expect(getKnownToolContract('create_task')).toMatchObject({
      id: 'create_task',
      source: 'contract',
    });
    expect(getKnownToolContract('entity_action')).toMatchObject({
      id: 'entity_action',
      source: 'inline',
    });
  });

  it('can describe every inline-registered tool', () => {
    const missing = collectInlineRegisteredToolIds().filter(
      (toolId) => !getKnownToolContract(toolId)
    );

    expect(
      missing,
      `Inline tools missing orgx_describe_tool coverage: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('describes each known tool id exactly once', () => {
    const knownContracts = getKnownToolContracts();
    const duplicateIds = knownContracts
      .map((tool) => tool.id)
      .filter((toolId, index, ids) => ids.indexOf(toolId) !== index)
      .sort();

    expect(
      duplicateIds,
      `Duplicate orgx_describe_tool contracts: ${duplicateIds.join(', ')}`
    ).toEqual([]);
  });

  it('does not shadow inline-registered tools with duplicate descriptors', () => {
    const knownContracts = getKnownToolContracts();
    const shadowedInlineTools = collectInlineRegisteredToolIds()
      .map((toolId) => ({
        toolId,
        count: knownContracts.filter((tool) => tool.id === toolId).length,
      }))
      .filter(({ count }) => count !== 1);

    expect(
      shadowedInlineTools,
      `Inline tools with duplicate/missing descriptors: ${shadowedInlineTools
        .map(({ toolId, count }) => `${toolId}:${count}`)
        .join(', ')}`
    ).toEqual([]);
  });

  it('exposes non-empty input contracts for every inline-registered tool', () => {
    const missingInputContracts = collectInlineRegisteredToolIds()
      .map((toolId) => getKnownToolContract(toolId))
      .filter((contract) => contract?.source === 'inline')
      .filter((contract) => !contract?.inputSchema || Object.keys(contract.inputSchema).length === 0)
      .map((contract) => contract?.id);

    expect(
      missingInputContracts,
      `Inline tools missing input contracts: ${missingInputContracts.join(', ')}`
    ).toEqual([]);
  });

  it('exposes proof_profile on create_task and create_milestone', () => {
    for (const toolId of ['create_task', 'create_milestone'] as const) {
      const tool = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === toolId);
      expect(tool, `${toolId} should be registered`).toBeDefined();
      const schema = tool!.inputSchema as Record<string, z.ZodTypeAny>;
      expect(schema.proof_profile, `${toolId} must accept proof_profile`).toBeDefined();

      // Valid proof_profile values parse cleanly.
      for (const profile of [
        'full',
        'subcomponent',
        'release',
        'external_artifact',
      ] as const) {
        expect(() => schema.proof_profile.parse(profile)).not.toThrow();
      }

      // Invalid values are rejected.
      expect(() => schema.proof_profile.parse('invalid')).toThrow();
    }
  });

  it('allows planning sessions to be scoped to a workspace', () => {
    const orgxPlan = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === 'orgx_plan');
    expect(orgxPlan, 'orgx_plan should be registered').toBeDefined();
    const orgxPlanSchema = orgxPlan!.inputSchema as Record<string, z.ZodTypeAny>;
    expect(orgxPlanSchema.workspace_id.description).toContain('Workspace UUID');
    expect(orgxPlanSchema.workspace_id.description).toContain('current session workspace');
  });

  it('marks agent dispatch wrappers as open-world and destructive', () => {
    for (const toolId of ['orgx_spawn', 'delegate_agent_task'] as const) {
      const tool = CONTRACT_TOOL_DEFINITIONS.find((entry) => entry.id === toolId);
      expect(tool, `${toolId} should be registered`).toBeDefined();
      expect(tool!.annotations).toMatchObject({
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      });
    }
  });

  it('allows decision listing wrappers to be scoped to a workspace', () => {
    for (const toolId of ['orgx_decide', 'approve_agent_work'] as const) {
      const tool = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === toolId);
      expect(tool, `${toolId} should be registered`).toBeDefined();
      const schema = tool!.inputSchema as Record<string, z.ZodTypeAny>;
      expect(schema.workspace_id, `${toolId} must accept workspace_id`).toBeDefined();
      expect(schema.workspace_id.description).toContain('workspace');
    }
  });

  it('exposes workspaces through the canonical inspect, write, and act tools', () => {
    const inspect = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === 'orgx_inspect')!;
    const write = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === 'orgx_write')!;
    const act = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === 'orgx_act')!;
    const inspectSchema = inspect.inputSchema as Record<string, z.ZodTypeAny>;
    const writeSchema = write.inputSchema as Record<string, z.ZodTypeAny>;
    const actSchema = act.inputSchema as Record<string, z.ZodTypeAny>;

    expect(() => inspectSchema.type.parse('workspace')).not.toThrow();
    expect(writeSchema.type.description).toContain('workspace');
    expect(writeSchema.set_active).toBeDefined();
    expect(() => actSchema.type.parse('workspace')).not.toThrow();
    expect(act.description).toContain('workspace: update|delete');
  });

  it('allows every visible canonical entity type to be inspected', () => {
    const inspect = CONTRACT_TOOL_DEFINITIONS.find(
      (tool) => tool.id === 'orgx_inspect'
    )!;
    const schema = inspect.inputSchema as Record<string, z.ZodTypeAny>;

    for (const entityType of ENTITY_TYPES) {
      expect(
        () => schema.type.parse(entityType),
        `${entityType} should be inspectable`
      ).not.toThrow();
    }
  });

  it('documents live initiative create requirements that prevent known write failures', () => {
    const tool = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === 'orgx_write');
    expect(tool, 'orgx_write should be registered').toBeDefined();

    const description = tool!.description;
    const schema = tool!.inputSchema as Record<string, z.ZodTypeAny>;

    expect(description).toContain('workspace_id');
    expect(description).toContain('goal_ids');
    expect(description).toContain('primary objectives');
    expect(description).toContain('idempotent replay');
    expect(description).toContain('due_date is not accepted on initiative create');
    expect(description).toContain('not portfolio labels such as active/critical/maintenance/hold');
    expect(schema.priority.description).toContain('do not send portfolio/live labels');
    expect(schema.priority.description).toContain('active');
    expect(schema.due_date.description).toContain('Do not send due_date when type="initiative"');
    expect(schema.milestone_id.description).toContain('explicit backlog milestone');
  });

  it('uses human-facing aliases for search, inspect, and scaffold discovery', () => {
    const searchTool = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === 'orgx_search');
    const inspectTool = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === 'orgx_inspect');
    const scaffoldTool = getKnownToolContract('scaffold_initiative');

    expect(searchTool?.description).toContain('Search OrgX');
    expect(searchTool?.description).toContain('find initiative ID');
    expect(inspectTool?.description).toContain('Inspect OrgX Entity');
    expect(inspectTool?.description).toContain('get full entity context');
    expect(scaffoldTool?.description).toContain('Scaffold an initiative hierarchy');
    expect(scaffoldTool?.description).toContain('initiative_id');
    expect(scaffoldTool?.description).toContain('preferred_next_calls');
  });

  it('documents URL-backed artifact requirements for write, attach, and proof actions', () => {
    const writeTool = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === 'orgx_write');
    const attachTool = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === 'orgx_attach');
    const actTool = CONTRACT_TOOL_DEFINITIONS.find((t) => t.id === 'orgx_act');

    expect(writeTool, 'orgx_write should be registered').toBeDefined();
    expect(attachTool, 'orgx_attach should be registered').toBeDefined();
    expect(actTool, 'orgx_act should be registered').toBeDefined();

    const writeSchema = writeTool!.inputSchema as Record<string, z.ZodTypeAny>;
    const attachSchema = attachTool!.inputSchema as Record<string, z.ZodTypeAny>;
    const actSchema = actTool!.inputSchema as Record<string, z.ZodTypeAny>;

    expect(writeTool!.description).toContain('artifact_url/external_url');
    expect(writeTool!.description).not.toContain('artifact_url/external_url/preview_markdown');
    expect(writeSchema.artifact_url.description).toContain('preview_markdown alone is not accepted');
    expect(writeSchema.preview_markdown.description).toContain('does not replace artifact_url/external_url');

    expect(attachTool!.description).toContain('Requires artifact_url or external_url');
    expect(attachTool!.description).not.toContain('or preview');
    expect(attachSchema.artifact_url.description).toContain('preview_markdown alone is rejected');
    expect(attachSchema.preview_markdown.description).toContain('Does not replace artifact_url/external_url');

    expect(actTool!.description).toContain('artifact_type + artifact_url/external_url');
    expect(actTool!.description).toContain('update dry-runs must return would_update');
    expect(actSchema.artifact.description).toContain('Either artifact_url or external_url is required');
    expect(actSchema.artifact.description).toContain('preview_markdown alone is rejected');
    expect(actSchema.dry_run.description).toContain('must not delegate to orgx_write');
  });

  it('documents consolidate_pr server-side GitHub credential requirements', () => {
    const tool = CLIENT_INTEGRATION_TOOL_DEFINITIONS.find(
      (definition) => definition.id === 'consolidate_pr'
    );
    expect(tool, 'consolidate_pr should be registered').toBeDefined();

    const schema = tool!.inputSchema as Record<string, z.ZodTypeAny>;
    expect(tool!.description).toContain('server-side GitHub credentials');
    expect(tool!.description).toContain('GitHub token is unavailable');
    expect(schema.pr_url.description).toContain('server-side GitHub credentials');
  });
});
