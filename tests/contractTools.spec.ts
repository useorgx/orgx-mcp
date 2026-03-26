import { describe, expect, it } from 'vitest';

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
});
