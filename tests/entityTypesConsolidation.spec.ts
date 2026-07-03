// Ported from the orgx monorepo's studio-entity-consolidation spec when the
// vendored worker copy at orgx/workers/orgx-mcp was removed. Pins entity-type
// registration, lifecycle membership, action maps, and the removal of the
// standalone studio/video tool definition exports.
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ENTITY_TYPES,
  entityTypeEnum,
  LIFECYCLE_ENTITY_TYPES,
  lifecycleEntityTypeEnum,
  LAUNCH_ACTION_MAP,
  PAUSE_ACTION_MAP,
} from '../src/toolDefinitions';

describe('Studio Entity Type Registration', () => {
  it('should include studio_brand in ENTITY_TYPES', () => {
    expect(ENTITY_TYPES).toContain('studio_brand');
  });

  it('should include studio_content in ENTITY_TYPES', () => {
    expect(ENTITY_TYPES).toContain('studio_content');
  });

  it('should include video_template in ENTITY_TYPES', () => {
    expect(ENTITY_TYPES).toContain('video_template');
  });

  it('entityTypeEnum should accept studio_brand', () => {
    expect(() => entityTypeEnum.parse('studio_brand')).not.toThrow();
  });

  it('entityTypeEnum should accept studio_content', () => {
    expect(() => entityTypeEnum.parse('studio_content')).not.toThrow();
  });

  it('entityTypeEnum should accept video_template', () => {
    expect(() => entityTypeEnum.parse('video_template')).not.toThrow();
  });

  it('entityTypeEnum should reject unknown types', () => {
    expect(() => entityTypeEnum.parse('studio_video')).toThrow();
    expect(() => entityTypeEnum.parse('brand')).toThrow();
  });
});

describe('Studio Lifecycle Entity Registration', () => {
  it('should include studio_content in LIFECYCLE_ENTITY_TYPES', () => {
    expect(LIFECYCLE_ENTITY_TYPES).toContain('studio_content');
  });

  it('lifecycleEntityTypeEnum should accept studio_content', () => {
    expect(() => lifecycleEntityTypeEnum.parse('studio_content')).not.toThrow();
  });

  it('should NOT include studio_brand in LIFECYCLE_ENTITY_TYPES (no lifecycle actions)', () => {
    expect(LIFECYCLE_ENTITY_TYPES).not.toContain('studio_brand');
  });

  it('should NOT include video_template in LIFECYCLE_ENTITY_TYPES (static type)', () => {
    expect(LIFECYCLE_ENTITY_TYPES).not.toContain('video_template');
  });
});

describe('Standalone Studio/Video Tool Definitions Removed', () => {
  // Verify via static imports that the removed exports no longer exist.
  // If STUDIO_TOOL_DEFINITIONS or VIDEO_TOOL_DEFINITIONS were still exported,
  // they would be importable alongside the other named exports above.
  // We verify they are absent by importing * and checking keys.

  let toolDefExports: Record<string, unknown>;

  beforeEach(async () => {
    toolDefExports = await import('../src/toolDefinitions');
  });

  it('should NOT export STUDIO_TOOL_DEFINITIONS', () => {
    expect(toolDefExports.STUDIO_TOOL_DEFINITIONS).toBeUndefined();
  });

  it('should NOT export VIDEO_TOOL_DEFINITIONS', () => {
    expect(toolDefExports.VIDEO_TOOL_DEFINITIONS).toBeUndefined();
  });

  it('should still export STREAM_TOOL_DEFINITIONS (not consolidated)', () => {
    expect(toolDefExports.STREAM_TOOL_DEFINITIONS).toBeDefined();
    expect(Array.isArray(toolDefExports.STREAM_TOOL_DEFINITIONS)).toBe(true);
  });

  it('should still export CHATGPT_TOOL_DEFINITIONS', () => {
    expect(toolDefExports.CHATGPT_TOOL_DEFINITIONS).toBeDefined();
  });

  it('should still export PLAN_SESSION_TOOLS', () => {
    expect(toolDefExports.PLAN_SESSION_TOOLS).toBeDefined();
  });
});

describe('Existing Entity Types Preserved (regression)', () => {
  const expectedTypes = [
    'workspace',
    'project',
    'initiative',
    'milestone',
    'workstream',
    'task',
    'objective',
    'playbook',
    'decision',
    'artifact',
    'run',
    'blocker',
    'workflow',
    'agent',
    'skill',
    'plan_session',
    'stream',
  ];

  for (const type of expectedTypes) {
    it(`should still include ${type} in ENTITY_TYPES`, () => {
      expect(ENTITY_TYPES).toContain(type);
    });
  }

  const expectedLifecycleTypes = [
    'initiative',
    'milestone',
    'workstream',
    'task',
    'objective',
    'playbook',
    'decision',
    'stream',
  ];

  for (const type of expectedLifecycleTypes) {
    it(`should still include ${type} in LIFECYCLE_ENTITY_TYPES`, () => {
      expect(LIFECYCLE_ENTITY_TYPES).toContain(type);
    });
  }
});

describe('Action Maps', () => {
  it('LAUNCH_ACTION_MAP should not have studio_brand entry', () => {
    expect(LAUNCH_ACTION_MAP).not.toHaveProperty('studio_brand');
  });

  it('LAUNCH_ACTION_MAP should not have studio_content entry', () => {
    expect(LAUNCH_ACTION_MAP).not.toHaveProperty('studio_content');
  });

  it('PAUSE_ACTION_MAP should not have studio_brand entry', () => {
    expect(PAUSE_ACTION_MAP).not.toHaveProperty('studio_brand');
  });

  it('PAUSE_ACTION_MAP should not have studio_content entry', () => {
    expect(PAUSE_ACTION_MAP).not.toHaveProperty('studio_content');
  });

  it('existing action maps should still be intact', () => {
    expect(LAUNCH_ACTION_MAP.initiative).toBe('launch');
    expect(LAUNCH_ACTION_MAP.task).toBe('start');
    expect(LAUNCH_ACTION_MAP.stream).toBe('start');
    expect(PAUSE_ACTION_MAP.initiative).toBe('pause');
    expect(PAUSE_ACTION_MAP.task).toBe('block');
    expect(PAUSE_ACTION_MAP.stream).toBe('block');
  });
});
