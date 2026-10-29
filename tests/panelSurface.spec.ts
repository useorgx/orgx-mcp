import { describe, expect, it, vi } from 'vitest';

import {
  PANEL_RESOURCE_URI,
  PANEL_TOOL_META,
  PANEL_TOOL_NAME,
  registerPanelTool,
} from '../src/panelSurface';

describe('panel surface contract', () => {
  it('publishes a versioned panel resource under the app-only visibility and global/thread entrypoints', () => {
    expect(PANEL_TOOL_NAME).toBe('orgx_panel_snapshot');
    expect(PANEL_RESOURCE_URI).toMatch(/^ui:\/\/widget\/orgx-panel\.html\?v=.+$/);
    expect(PANEL_TOOL_META).toMatchObject({
      ui: {
        resourceUri: PANEL_RESOURCE_URI,
        visibility: ['app'],
      },
      'openai/ui': {
        entrypoints: [{ type: 'global' }, { type: 'thread' }],
      },
    });
  });

  it('registers only the panel selection input as a read-only app tool', () => {
    const registerTool = vi.fn();
    const handler = vi.fn();
    registerPanelTool({ registerTool } as never, handler);

    const [name, config] = registerTool.mock.calls[0] as [string, Record<string, any>];
    expect(name).toBe('orgx_panel_snapshot');
    expect(config.annotations.readOnlyHint).toBe(true);
    expect(config._meta.ui).toMatchObject({
      resourceUri: PANEL_RESOURCE_URI,
      visibility: ['app'],
    });
    expect(config._meta['openai/ui'].entrypoints).toEqual([
      { type: 'global' },
      { type: 'thread' },
    ]);
    expect(Object.keys(config.inputSchema)).toEqual(['focus']);
  });
});
