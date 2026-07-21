import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  STREAM_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { FLYWHEEL_TOOL_DEFINITIONS } from '../src/flywheelTools';
import { resolveProfileToolSet } from '../src/toolProfiles';

type ToolDef = { id: string; _meta?: Record<string, unknown> };

const INLINE_HANDLED_TOOLS = new Set(['workspace', 'configure_org', 'stats']);

function extractIds(defs: ReadonlyArray<{ id: string }>): string[] {
  return defs.map((d) => d.id);
}

function findDuplicates(arr: string[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const id of arr) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  return dupes;
}

function collectInlineRegisteredToolIds(): string[] {
  const src = readWorkerSource();
  const ids = new Set<string>();
  const inlineRe = /this\.server\.registerTool\(\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  const appRe = /registerAppTool\(\s*this\.server,\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = inlineRe.exec(src))) ids.add(match[1]!);
  while ((match = appRe.exec(src))) ids.add(match[1]!);

  return [...ids].sort();
}

function readWorkerSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexPath = resolvePath(here, '..', 'src', 'index.ts');
  return readFileSync(indexPath, 'utf8');
}

describe('MCP Worker tool registration integrity', () => {
  const chatgptIds = extractIds(
    CHATGPT_TOOL_DEFINITIONS as unknown as { id: string }[]
  );
  const planIds = extractIds(PLAN_SESSION_TOOLS as unknown as { id: string }[]);
  const streamIds = extractIds(
    STREAM_TOOL_DEFINITIONS as unknown as { id: string }[]
  );
  const clientIds = extractIds(
    CLIENT_INTEGRATION_TOOL_DEFINITIONS as unknown as { id: string }[]
  );
  const contractIds = extractIds(
    CONTRACT_TOOL_DEFINITIONS as unknown as { id: string }[]
  );
  const inlineIds = collectInlineRegisteredToolIds();
  const flywheelIds = extractIds(
    FLYWHEEL_TOOL_DEFINITIONS as unknown as { id: string }[]
  );

  it('CHATGPT_TOOL_DEFINITIONS has no duplicate IDs', () => {
    expect(findDuplicates(chatgptIds)).toEqual([]);
  });

  it('PLAN_SESSION_TOOLS has no duplicate IDs', () => {
    expect(findDuplicates(planIds)).toEqual([]);
  });

  it('STREAM_TOOL_DEFINITIONS has no duplicate IDs', () => {
    expect(findDuplicates(streamIds)).toEqual([]);
  });

  it('CLIENT_INTEGRATION_TOOL_DEFINITIONS has no duplicate IDs', () => {
    expect(findDuplicates(clientIds)).toEqual([]);
  });

  it('CONTRACT_TOOL_DEFINITIONS has no duplicate IDs', () => {
    expect(findDuplicates(contractIds)).toEqual([]);
  });

  it('every v2-surface tool that ships an output template is registered public (ChatGPT hides private template tools)', () => {
    // ChatGPT disables a widget template if its owning tool is hidden ("Templates
    // tied to hidden tools won't be usable"). Both registration paths must therefore
    // force-public any tool carrying an openai/outputTemplate, regardless of whether
    // it is a write tool. This guards the fix for orgx_decide/orgx_plan/etc.
    const v2 = resolveProfileToolSet('v2') ?? new Set<string>();
    const allDefs = [
      ...(CHATGPT_TOOL_DEFINITIONS as unknown as ToolDef[]),
      ...(CONTRACT_TOOL_DEFINITIONS as unknown as ToolDef[]),
    ];
    const templateToolsInV2 = allDefs.filter(
      (d) =>
        v2.has(d.id) &&
        Boolean((d._meta as Record<string, unknown> | undefined)?.['openai/outputTemplate'])
    );
    // Sanity: the known decision/plan/agent widgets are present in v2.
    expect(templateToolsInV2.map((d) => d.id)).toEqual(
      expect.arrayContaining(['orgx_decide', 'orgx_plan'])
    );

    // The worker source must compute visibility from outputTemplate in BOTH paths.
    const src = readWorkerSource();
    const visibilityClauses = src.match(/openai\/outputTemplate'\]\)/g) ?? [];
    expect(
      src.includes('hasOutputTemplate'),
      'index.ts must force-public template-bearing tools via hasOutputTemplate in registration'
    ).toBe(true);
    expect(
      visibilityClauses.length,
      'both registerChatGPTTools and registerContractTools must derive hasOutputTemplate'
    ).toBeGreaterThanOrEqual(2);

    const scaffoldStart = src.search(
      /registerAppTool\(\s*this\.server,\s*'scaffold_initiative'/
    );
    expect(scaffoldStart, 'scaffold_initiative inline registration must exist').toBeGreaterThanOrEqual(0);
    const scaffoldEnd = src.indexOf(
      'async (args: Record<string, unknown>) =>',
      scaffoldStart
    );
    expect(scaffoldEnd, 'scaffold_initiative handler must exist').toBeGreaterThan(scaffoldStart);
    const scaffoldRegistration = src.slice(scaffoldStart, scaffoldEnd);
    expect(scaffoldRegistration).toContain('SCAFFOLD_INITIATIVE_WIDGET_META');
    expect(scaffoldRegistration).toContain("'openai/visibility': 'public'");
  });

  it('definition arrays have no overlapping IDs', () => {
    const allDefinitionIds = [
      ...chatgptIds,
      ...planIds,
      ...streamIds,
      ...clientIds,
      ...contractIds,
    ];
    const dupes = findDuplicates(allDefinitionIds);
    expect(dupes).toEqual([]);
  });

  it('all tools shared between CHATGPT_TOOL_DEFINITIONS and inline registrations are in INLINE_HANDLED_TOOLS skip-set', () => {
    const inlineSet = new Set(inlineIds);
    const sharedTools = chatgptIds.filter((id) => inlineSet.has(id));

    for (const toolId of sharedTools) {
      expect(
        INLINE_HANDLED_TOOLS.has(toolId),
        `Tool "${toolId}" exists in both CHATGPT_TOOL_DEFINITIONS and inline registrations but is NOT in INLINE_HANDLED_TOOLS skip-set.`
      ).toBe(true);
    }
  });

  it('PLAN_SESSION_TOOLS does not overlap with inline registrations', () => {
    const inlineSet = new Set(inlineIds);
    const overlap = planIds.filter((id) => inlineSet.has(id));
    expect(overlap).toEqual([]);
  });

  it('STREAM_TOOL_DEFINITIONS does not overlap with inline registrations', () => {
    const inlineSet = new Set(inlineIds);
    const overlap = streamIds.filter((id) => inlineSet.has(id));
    expect(overlap).toEqual([]);
  });

  it('CLIENT_INTEGRATION_TOOL_DEFINITIONS does not overlap with inline registrations', () => {
    const inlineSet = new Set(inlineIds);
    const overlap = clientIds.filter((id) => inlineSet.has(id));
    expect(overlap).toEqual([]);
  });

  it('CONTRACT_TOOL_DEFINITIONS does not overlap with inline registrations', () => {
    const inlineSet = new Set(inlineIds);
    const overlap = contractIds.filter((id) => inlineSet.has(id));
    expect(overlap).toEqual([]);
  });

  it('flywheel tools do not overlap with definition arrays', () => {
    const allDefIds = new Set([
      ...chatgptIds,
      ...planIds,
      ...streamIds,
      ...clientIds,
      ...contractIds,
    ]);
    const overlap = flywheelIds.filter((id) => allDefIds.has(id));
    expect(overlap).toEqual([]);
  });

  it('flywheel tool definitions are implemented by inline registrations', () => {
    const inlineSet = new Set(inlineIds);
    const missingHandlers = flywheelIds.filter((id) => !inlineSet.has(id));
    expect(
      missingHandlers,
      `Flywheel tool definitions without inline handlers: ${missingHandlers.join(', ')}`
    ).toEqual([]);
  });

  it('flywheel tools expose the governed outcome taxonomy recovery path', () => {
    const configureIndex = flywheelIds.indexOf('configure_outcome_type');
    const recordIndex = flywheelIds.indexOf('record_outcome');
    const recordOutcome = (
      FLYWHEEL_TOOL_DEFINITIONS as unknown as {
        id: string;
        description: string;
      }[]
    ).find((tool) => tool.id === 'record_outcome');

    expect(configureIndex).toBeGreaterThanOrEqual(0);
    expect(recordIndex).toBeGreaterThan(configureIndex);
    expect(recordOutcome?.description).toContain(
      'call configure_outcome_type first'
    );
  });

  it('all tool IDs match MCP naming pattern ^[a-zA-Z0-9_-]{1,64}$', () => {
    const allIds = [
      ...chatgptIds,
      ...planIds,
      ...streamIds,
      ...clientIds,
      ...contractIds,
      ...inlineIds,
      ...flywheelIds,
    ];
    const pattern = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const id of allIds) {
      expect(id, `Tool ID "${id}" does not match MCP naming convention`).toMatch(
        pattern
      );
    }
  });

  it('after applying INLINE_HANDLED_TOOLS skip-set, no tool ID would be registered twice', () => {
    const chatgptRegistered = chatgptIds.filter(
      (id) => !INLINE_HANDLED_TOOLS.has(id)
    );

    const inlineSet = new Set(inlineIds);
    const flywheelCatalogOnlyIds = flywheelIds.filter((id) => !inlineSet.has(id));

    const allRegistered = [
      ...chatgptRegistered,
      ...planIds,
      ...streamIds,
      ...clientIds,
      ...contractIds,
      ...inlineIds,
      ...flywheelCatalogOnlyIds,
    ];

    const dupes = findDuplicates(allRegistered);
    expect(dupes).toEqual([]);
  });

  it('INLINE_HANDLED_TOOLS skip-set contains only tools that exist in CHATGPT_TOOL_DEFINITIONS', () => {
    const chatgptSet = new Set(chatgptIds);
    for (const toolId of INLINE_HANDLED_TOOLS) {
      expect(
        chatgptSet.has(toolId),
        `INLINE_HANDLED_TOOLS contains "${toolId}" which is NOT in CHATGPT_TOOL_DEFINITIONS.`
      ).toBe(true);
    }
  });

  it('INLINE_HANDLED_TOOLS skip-set contains only tools that are inline-registered', () => {
    const inlineSet = new Set(inlineIds);
    for (const toolId of INLINE_HANDLED_TOOLS) {
      expect(
        inlineSet.has(toolId),
        `INLINE_HANDLED_TOOLS contains "${toolId}" which is NOT inline-registered.`
      ).toBe(true);
    }
  });

  it('orgx_act and entity_action update dry-runs do not call write endpoints', () => {
    const src = readWorkerSource();
    const contractUpdateBranch = src.match(
      /if \(args\.action === 'update'\) \{[\s\S]*?return this\.executeContractTool\(\s*'orgx_write'/
    )?.[0];
    const inlineUpdateBranch = src.match(
      /if \(resolvedAction === 'update'\) \{[\s\S]*?const response = await callOrgxApiJson/
    )?.[0];

    expect(contractUpdateBranch).toBeDefined();
    expect(inlineUpdateBranch).toBeDefined();
    expect(contractUpdateBranch).toContain('args.dry_run === true');
    expect(inlineUpdateBranch).toContain('args.dry_run === true');
    expect(contractUpdateBranch!.indexOf('args.dry_run === true')).toBeLessThan(
      contractUpdateBranch!.indexOf("return this.executeContractTool(\n              'orgx_write'")
    );
    expect(inlineUpdateBranch!.indexOf('args.dry_run === true')).toBeLessThan(
      inlineUpdateBranch!.indexOf('const response = await callOrgxApiJson')
    );
  });

  it('routes both complete_with_proof surfaces through the shared composite flow', () => {
    const src = readWorkerSource();
    const sharedCalls =
      src.match(/return this\.executeCompleteWithProof\(/g) ?? [];
    expect(sharedCalls).toHaveLength(2);

    const compactStart = src.indexOf("case 'orgx_act':");
    const compactEnd = src.indexOf("case 'orgx_plan':", compactStart);
    const compactHandler = src.slice(compactStart, compactEnd);
    const specialBranch = compactHandler.indexOf(
      "resolvedAction === 'complete_with_proof'"
    );
    const genericForward = compactHandler.indexOf(
      '`/api/entities/${args.type}/${args.id}/${resolvedAction}`'
    );

    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(compactEnd).toBeGreaterThan(compactStart);
    expect(specialBranch).toBeGreaterThanOrEqual(0);
    expect(compactHandler).toContain(
      "return this.executeCompleteWithProof("
    );
    expect(genericForward).toBeGreaterThan(specialBranch);
  });

  it('start_plan_session defaults workspace_id from session context when omitted', () => {
    const src = readWorkerSource();
    const startPlanBranch = src.match(
      /if \(toolId === 'start_plan_session'\) \{[\s\S]*?init\.body = JSON\.stringify\(body\);/
    )?.[0];

    expect(startPlanBranch).toBeDefined();
    expect(startPlanBranch).toContain('body.workspace_id');
    expect(startPlanBranch).toContain('this.sessionContext.workspaceId');
    expect(startPlanBranch!.indexOf('body.workspace_id')).toBeLessThan(
      startPlanBranch!.indexOf('init.body = JSON.stringify(body);')
    );
  });
});
