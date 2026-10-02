import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  PANEL_SNAPSHOT_TOOL_CONTRACT,
  PANEL_TOOL_ID,
  PANEL_TOOL_META,
  registerPanelSurface,
  type PanelSurfaceHost,
} from '../src/panelSurface';
import { getKnownToolContract } from '../src/contractTools';
import {
  CHATGPT_TOOL_DEFINITIONS,
  SECURITY_SCHEMES,
  WIDGET_RESOURCES,
  WIDGET_URIS,
} from '../src/toolDefinitions';
import {
  CHATGPT_PUBLIC_SURFACE,
  CLAUDE_DIRECTORY_SURFACE,
  CLAUDE_PLUGIN_SURFACE,
  resolveProfileToolSet,
} from '../src/toolProfiles';
import { getOpenAiOutputSchema } from '../src/openaiOutputSchemas';
import serverManifest from '../server.json';

const workerSource = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

type Registration = {
  name: string;
  config: Record<string, unknown> & {
    _meta: Record<string, unknown>;
    inputSchema: Record<string, z.ZodTypeAny>;
    annotations: Record<string, boolean>;
  };
};

function captureRegistration(allowed: ReadonlySet<string> | null = null): Registration[] {
  const registrations: Registration[] = [];
  const server = {
    registerTool: vi.fn((name: string, config: Registration['config']) => {
      registrations.push({ name, config });
      return {};
    }),
  };
  registerPanelSurface(server as never, allowed, {} as PanelSurfaceHost);
  return registrations;
}

describe('orgx_panel_snapshot registration', () => {
  it('registers one app-only, read-only tool with the global and thread entrypoints', () => {
    const [registration] = captureRegistration();
    expect(registration?.name).toBe('orgx_panel_snapshot');
    const meta = registration!.config._meta;
    expect(meta.ui).toEqual({ resourceUri: WIDGET_URIS.orgxPanel, visibility: ['app'] });
    expect(meta['openai/ui']).toEqual({
      entrypoints: [{ type: 'global' }, { type: 'thread' }],
    });
    expect(meta['mcp/securitySchemes']).toEqual(SECURITY_SCHEMES.entityReadRequiresAuth);
    expect(registration!.config.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(WIDGET_URIS.orgxPanel).toMatch(/^ui:\/\/widget\/orgx-panel\.html\?v=/);
  });

  it('takes an optional decision focus and nothing else (no workspace_id)', () => {
    const [registration] = captureRegistration();
    const input = z.object(registration!.config.inputSchema).strict();
    expect(Object.keys(registration!.config.inputSchema)).toEqual(['focus']);
    expect(input.safeParse({}).success).toBe(true);
    expect(
      input.safeParse({ focus: { type: 'decision', id: '3f1c2a9e-6b7d-4c1e-9a2b-1d2e3f4a5b6c' } }).success
    ).toBe(true);
    expect(input.safeParse({ focus: { type: 'artifact', id: '3f1c2a9e-6b7d-4c1e-9a2b-1d2e3f4a5b6c' } }).success).toBe(false);
    expect(input.safeParse({ focus: { type: 'decision', id: 'not-a-uuid' } }).success).toBe(false);
    expect(input.safeParse({ workspace_id: '3f1c2a9e-6b7d-4c1e-9a2b-1d2e3f4a5b6c' }).success).toBe(false);
  });

  it('respects the profile allowlist', () => {
    expect(captureRegistration(new Set(['orgx_search']))).toEqual([]);
    expect(captureRegistration(new Set([PANEL_TOOL_ID]))).toHaveLength(1);
  });

  it('is on the ChatGPT and v2 surfaces only, with a contract, an exact output schema and a manifest entry', () => {
    expect(CHATGPT_PUBLIC_SURFACE).toContain(PANEL_TOOL_ID);
    expect(resolveProfileToolSet('v2')?.has(PANEL_TOOL_ID)).toBe(true);
    expect(CLAUDE_DIRECTORY_SURFACE).not.toContain(PANEL_TOOL_ID as never);
    expect(CLAUDE_PLUGIN_SURFACE).not.toContain(PANEL_TOOL_ID as never);
    expect(getKnownToolContract(PANEL_TOOL_ID)?.securitySchemes).toEqual(
      PANEL_SNAPSHOT_TOOL_CONTRACT.securitySchemes
    );
    expect(getOpenAiOutputSchema(PANEL_TOOL_ID)).toBeDefined();
    const manifest = serverManifest.tools.find((tool) => tool.name === PANEL_TOOL_ID);
    expect(manifest?.annotations).toEqual(PANEL_SNAPSHOT_TOOL_CONTRACT.annotations);
    expect(manifest?.description).toBe(PANEL_SNAPSHOT_TOOL_CONTRACT.description);
  });

  it('is wired from index.ts with one call and never touches session or live state', () => {
    expect(workerSource.match(/registerPanelSurface\(/g)).toHaveLength(1);
    const adapterStart = workerSource.indexOf('private panelSurfaceHost(): PanelSurfaceHost {');
    const adapterEnd = workerSource.indexOf('private maybeUpdateSessionInitiativeContext(', adapterStart);
    expect(adapterStart).toBeGreaterThan(0);
    const adapter = workerSource.slice(adapterStart, adapterEnd);
    expect(adapter).toContain('_widget_meta_channel: true');
    expect(adapter).not.toMatch(/maybeUpdateSessionInitiativeContext|saveSessionContext|buildStreamGrant|signStreamToken/);
    const panelSource = readFileSync(resolve(process.cwd(), 'src/panelSurface.ts'), 'utf8');
    expect(panelSource).not.toMatch(/maybeUpdateSessionInitiativeContext|buildStreamGrant|signStreamToken|\blive\b:/);
  });

  it('publishes the panel resource through the shared widget path with its display modes', () => {
    const panel = WIDGET_RESOURCES.find((widget) => widget.uri === WIDGET_URIS.orgxPanel);
    expect(panel).toMatchObject({
      name: 'orgx-panel-widget',
      contentMeta: { 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] } },
    });
    expect(workerSource).toContain("'contentMeta' in widget ? (widget.contentMeta as Record<string, unknown>) : null");
    expect(PANEL_TOOL_META['openai/widgetAccessible']).toBe(true);
  });

  it('leaves the existing decision tools and their widget contract unchanged', () => {
    const byId = new Map(CHATGPT_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]));
    const pending = byId.get('get_pending_decisions') as { _meta: Record<string, unknown> } | undefined;
    expect(pending?._meta.ui).toEqual({ resourceUri: WIDGET_URIS.decisions });
    expect(pending?._meta['openai/ui']).toBeUndefined();
    const decide = byId.get('orgx_widget_decide') as { _meta: Record<string, unknown> } | undefined;
    expect(decide?._meta['openai/widgetAccessible']).toBe(true);
    for (const tool of CHATGPT_TOOL_DEFINITIONS) {
      expect((tool._meta as Record<string, unknown>)['openai/ui'], tool.id).toBeUndefined();
    }
  });
});
