import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('widget avatar asset resolution', () => {
  const scaffoldSource = readFileSync(
    resolve(process.cwd(), 'public/widgets/scaffolded-initiative.html'),
    'utf8'
  );
  const agentStatusSource = readFileSync(
    resolve(process.cwd(), 'public/widgets/agent-status.html'),
    'utf8'
  );

  it('uses widget-hosted shared avatar assets for scaffolded initiative', () => {
    expect(scaffoldSource).toContain(
      "var WIDGET_ASSET_BASE = 'https://mcp.useorgx.com/widgets/shared/';"
    );
    expect(scaffoldSource).not.toContain('https://useorgx.com/product_orchestrator.png');
    expect(scaffoldSource).not.toContain('https://useorgx.com/engineering_autopilot.png');
  });

  it('uses widget-hosted shared avatar assets for agent status', () => {
    expect(agentStatusSource).toContain(
      "var REMOTE_WIDGET_ASSET_BASE = 'https://mcp.useorgx.com/widgets/shared/';"
    );
    expect(agentStatusSource).toMatch(
      /function resolveWidgetAsset\(path\)\{\s*return REMOTE_WIDGET_ASSET_BASE \+ path;\s*\}/
    );
  });
});
