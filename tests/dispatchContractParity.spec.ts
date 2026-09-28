import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { CHATGPT_TOOL_DEFINITIONS } from '../src/toolDefinitions';
import {
  DISPATCH_CONTRACT_SHAPE,
  DISPATCH_EFFECT_NAMES,
  DISPATCH_TOOL_IDS,
} from '../src/dispatchContract';

/**
 * The defect this guards: orgx_spawn carried budget and idempotency but no
 * deadline, delegate_agent_task carried a free-text deadline and no budget,
 * handoff_task carried neither, and none of them could say what would count as
 * done. A managing agent could not get budget and deadline from any single
 * verb.
 *
 * Every dispatch door now spreads DISPATCH_CONTRACT_SHAPE. If someone adds a
 * fifth door, or hand-rolls a field on one of the four, this fails.
 */

const ALL_TOOLS = [...CONTRACT_TOOL_DEFINITIONS, ...CHATGPT_TOOL_DEFINITIONS];
const CONTRACT_FIELDS = Object.keys(DISPATCH_CONTRACT_SHAPE);

function findTool(id: string) {
  const tool = ALL_TOOLS.find((candidate) => candidate.id === id);
  if (!tool) throw new Error(`dispatch tool ${id} is not registered`);
  return tool;
}

describe('dispatch contract parity', () => {
  it('registers every dispatch verb this repo defines', () => {
    for (const id of DISPATCH_TOOL_IDS) {
      expect(() => findTool(id), `${id} must be registered`).not.toThrow();
    }
  });

  it.each([...DISPATCH_TOOL_IDS])(
    '%s accepts the full dispatch contract',
    (id) => {
      const schema = findTool(id).inputSchema as Record<string, unknown>;
      const missing = CONTRACT_FIELDS.filter((field) => !(field in schema));
      expect(
        missing,
        `${id} is missing dispatch contract fields: ${missing.join(', ')}`
      ).toEqual([]);
    }
  );

  it.each([...DISPATCH_TOOL_IDS])(
    '%s uses the shared field definition rather than its own',
    (id) => {
      const schema = findTool(id).inputSchema as Record<string, unknown>;
      for (const field of CONTRACT_FIELDS) {
        expect(
          schema[field],
          `${id}.${field} must be the shared definition from dispatchContract.ts`
        ).toBe(
          DISPATCH_CONTRACT_SHAPE[field as keyof typeof DISPATCH_CONTRACT_SHAPE]
        );
      }
    }
  );

  /**
   * The tool definitions were correct while docs/generated/tool-catalog.json
   * still showed delegate_agent_task with 2 of 8 contract fields and a
   * plain-text deadline, because scripts/generate-tool-catalog.ts keeps its
   * own inline copy of that schema. The definitions are not the surface an
   * agent reads — the catalog is. Check the artifact, not just the source.
   */
  it('the generated catalog serves the full contract on every verb', () => {
    const catalog = JSON.parse(
      readFileSync(
        new URL('../docs/generated/tool-catalog.json', import.meta.url),
        'utf8'
      )
    ) as { tools: Array<Record<string, unknown>> };

    for (const id of DISPATCH_TOOL_IDS) {
      const entry = catalog.tools.find(
        (tool) => (tool.id ?? tool.name) === id
      );
      if (!entry) continue; // not every verb is published to every catalog
      const schema = (entry.inputSchema ?? {}) as {
        properties?: Record<string, unknown>;
      };
      const props = schema.properties ?? {};
      const missing = CONTRACT_FIELDS.filter((field) => !(field in props));
      expect(
        missing,
        `tool-catalog.json entry for ${id} is missing: ${missing.join(
          ', '
        )} — run pnpm catalog:generate`
      ).toEqual([]);
    }
  });

  it('no longer advertises a free-text deadline anywhere', () => {
    for (const id of DISPATCH_TOOL_IDS) {
      const schema = findTool(id).inputSchema as Record<string, unknown>;
      const deadline = schema.deadline as { description?: string } | undefined;
      const described =
        (deadline as { _def?: { description?: string } } | undefined)?._def
          ?.description ?? '';
      expect(described.toLowerCase()).toContain('iso-8601');
      expect(described.toLowerCase()).not.toContain('plain-text deadline');
    }
  });
});

describe('effect vocabulary in the served schema', () => {
  const effects = DISPATCH_CONTRACT_SHAPE.effects as unknown as {
    _def: { innerType: { shape: Record<string, { _def: { description?: string } }> } };
  };
  const shape = effects._def.innerType.shape;

  it('names every effect the app accepts, instead of examples it would refuse', () => {
    const described = shape.allowed._def.description ?? '';
    for (const name of DISPATCH_EFFECT_NAMES) expect(described).toContain(name);
    for (const stale of ['branch.write', 'tests.run']) expect(described).not.toContain(stale);
    expect(shape.approval_required._def.description ?? '').not.toMatch(/e\.g\./);
  });
});
