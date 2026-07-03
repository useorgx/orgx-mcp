// Ported from the orgx monorepo's studio-entity-consolidation spec when the
// vendored worker copy was removed. Pins the studio/video entity-type
// consolidation: the standalone tool definition arrays stay gone, and the
// consolidated entity types stay registered.
import { describe, expect, it } from 'vitest';

import * as toolDefExports from '../src/toolDefinitions';
import { ENTITY_TYPES } from '../src/toolDefinitions';

describe('studio/video entity consolidation', () => {
  it('includes studio_brand in ENTITY_TYPES', () => {
    expect(ENTITY_TYPES).toContain('studio_brand');
  });

  it('includes studio_content in ENTITY_TYPES', () => {
    expect(ENTITY_TYPES).toContain('studio_content');
  });

  it('includes video_template in ENTITY_TYPES', () => {
    expect(ENTITY_TYPES).toContain('video_template');
  });

  it('does NOT export STUDIO_TOOL_DEFINITIONS', () => {
    expect(
      (toolDefExports as Record<string, unknown>).STUDIO_TOOL_DEFINITIONS
    ).toBeUndefined();
  });

  it('does NOT export VIDEO_TOOL_DEFINITIONS', () => {
    expect(
      (toolDefExports as Record<string, unknown>).VIDEO_TOOL_DEFINITIONS
    ).toBeUndefined();
  });
});
