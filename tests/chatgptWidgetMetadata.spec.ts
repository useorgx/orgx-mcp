// Ported from the orgx monorepo's tests/server/strictToolSchema.spec.ts when
// the vendored worker copy was removed. Pins the ChatGPT widget metadata
// contract (openai/outputTemplate <-> ui.resourceUri) and the required
// ChatGPT tool surface.
import { describe, expect, it } from 'vitest';

import {
  CHATGPT_TOOL_DEFINITIONS,
  OUTPUT_TEMPLATE_URIS,
  WIDGET_URIS,
} from '../src/toolDefinitions';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { toWidgetHtmlResourceUri } from '../src/widgetConfig';

describe('MCP Apps widget metadata', () => {
  const widgetUriValues = new Set(Object.values(WIDGET_URIS));
  const outputTemplateUriValues = new Set(Object.values(OUTPUT_TEMPLATE_URIS));

  function isWidgetTool(
    tool: (typeof CHATGPT_TOOL_DEFINITIONS)[number]
  ): boolean {
    const meta = tool._meta as Record<string, unknown>;
    const ui = meta.ui as { resourceUri?: string } | undefined;
    return (
      typeof meta['openai/outputTemplate'] === 'string' ||
      typeof ui?.resourceUri === 'string'
    );
  }

  it('every widget-enabled ChatGPT tool has both openai/outputTemplate and ui.resourceUri in _meta', () => {
    const errors: string[] = [];

    for (const tool of CHATGPT_TOOL_DEFINITIONS) {
      if (!isWidgetTool(tool)) continue;
      const meta = tool._meta as Record<string, unknown>;
      if (!meta['openai/outputTemplate']) {
        errors.push(`${tool.id}: missing openai/outputTemplate in _meta`);
      }
      const ui = meta.ui as { resourceUri?: string } | undefined;
      if (!ui?.resourceUri) {
        errors.push(`${tool.id}: missing ui.resourceUri in _meta`);
      }
    }

    expect(errors).toEqual([]);
  });

  it('openai/outputTemplate maps to ui.resourceUri for each widget tool', () => {
    const errors: string[] = [];

    for (const tool of CHATGPT_TOOL_DEFINITIONS) {
      if (!isWidgetTool(tool)) continue;
      const meta = tool._meta as Record<string, unknown>;
      const outputTemplate = meta['openai/outputTemplate'] as
        | string
        | undefined;
      const ui = meta.ui as { resourceUri?: string } | undefined;
      const resourceUri = ui?.resourceUri;

      if (!outputTemplate || !resourceUri) continue;
      if (toWidgetHtmlResourceUri(outputTemplate) !== resourceUri) {
        errors.push(
          `${tool.id}: openai/outputTemplate (${outputTemplate}) must map to ui.resourceUri (${resourceUri})`
        );
      }
    }

    expect(errors).toEqual([]);
  });

  it('all ui.resourceUri and openai/outputTemplate values point to known WIDGET_URIS', () => {
    const errors: string[] = [];

    for (const tool of CHATGPT_TOOL_DEFINITIONS) {
      if (!isWidgetTool(tool)) continue;
      const meta = tool._meta as Record<string, unknown>;
      const outputTemplate = meta['openai/outputTemplate'] as
        | string
        | undefined;
      const ui = meta.ui as { resourceUri?: string } | undefined;
      if (ui?.resourceUri && !widgetUriValues.has(ui.resourceUri)) {
        errors.push(
          `${tool.id}: ui.resourceUri "${ui.resourceUri}" not in WIDGET_URIS`
        );
      }
      if (outputTemplate && !outputTemplateUriValues.has(outputTemplate)) {
        errors.push(
          `${tool.id}: openai/outputTemplate "${outputTemplate}" not in OUTPUT_TEMPLATE_URIS`
        );
      }
    }

    expect(errors).toEqual([]);
  });

  it('all required ChatGPT tools are present (plus optional diagnostics)', () => {
    const requiredToolIds = [
      'get_pending_decisions',
      'approve_decision',
      'reject_decision',
      'get_agent_status',
      'query_org_memory',
      'get_initiative_pulse',
      'spawn_agent_task',
      'handoff_task',
      'recommend_next_action',
      'get_decision_history',
      // Consolidated tools (replaced test_widget_render + individual scoring/queue/workspace tools)
      'scoring_config',
      'queue_action',
      'workspace',
      'configure_org',
      'stats',
    ];

    const actualToolIds = new Set(
      CHATGPT_TOOL_DEFINITIONS.map((tool) => tool.id)
    );
    for (const id of requiredToolIds) {
      expect(actualToolIds.has(id)).toBe(true);
    }

    expect(CHATGPT_TOOL_DEFINITIONS.length).toBeGreaterThanOrEqual(
      requiredToolIds.length
    );
  });

  it('spawn_agent_task exposes app-side routing and budget controls', () => {
    const mcpSpawnTool = CHATGPT_TOOL_DEFINITIONS.find(
      (tool) => tool.id === 'spawn_agent_task'
    );
    expect(mcpSpawnTool).toBeDefined();
    const mcpSchema = mcpSpawnTool?.inputSchema as
      | Record<string, unknown>
      | undefined;
    expect(mcpSchema?.sdk_backend).toBeDefined();
    expect(mcpSchema?.model_tier).toBeDefined();
    expect(mcpSchema?.model).toBeDefined();
    expect(mcpSchema?.provider).toBeDefined();
    expect(mcpSchema?.budget_mode).toBeDefined();
    expect(mcpSchema?.max_cost_usd).toBeDefined();

  });

  it('keeps the consolidated spawn surface on the task-spawned widget contract', () => {
    const tool = CONTRACT_TOOL_DEFINITIONS.find(
      (entry) => entry.id === 'orgx_spawn'
    );
    expect(tool).toBeDefined();
    const meta = tool?._meta as Record<string, unknown> | undefined;
    const ui = meta?.ui as { resourceUri?: string } | undefined;

    expect(meta?.['openai/outputTemplate']).toBe(
      OUTPUT_TEMPLATE_URIS.taskSpawned
    );
    expect(ui?.resourceUri).toBe(WIDGET_URIS.taskSpawned);
  });
});
