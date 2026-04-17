import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CONTRACT_TOOL_DEFINITIONS,
  getKnownToolContract,
} from '../src/contractTools';

describe('contract tool catalog', () => {
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
});
