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

  it('normalizes workstream assignment aliases before resolving avatars', () => {
    expect(scaffoldSource).toContain('var normalizeAgentDomain = (value) => {');
    expect(scaffoldSource).toContain("brand: 'marketing'");
    expect(scaffoldSource).toContain('item.assigned_agent_ids');
    expect(scaffoldSource).toContain('metadata.assigned_agent_ids');
  });

  it('shows truthful routing state instead of inventing an Unassigned owner', () => {
    const domainSource = readFileSync(
      resolve(
        process.cwd(),
        'public/widgets/shared/components/domain-accent.js'
      ),
      'utf8'
    );
    expect(scaffoldSource).not.toContain("'Unassigned'");
    expect(domainSource).not.toContain("'Unassigned'");
    expect(scaffoldSource).toContain("'OrgX routing'");
    expect(domainSource).toContain("'owner pending'");
  });

  it('keeps the streaming scaffold renderer on the same domain contract', () => {
    const streamingSource = readFileSync(
      resolve(process.cwd(), 'public/widgets/scaffold-streaming.html'),
      'utf8'
    );
    expect(streamingSource).toContain('function normalizeAgentDomain(value) {');
    expect(streamingSource).toContain("brand: 'marketing'");
    expect(streamingSource).toContain('entity.assigned_agent_ids');
  });

  it('uses widget-hosted shared avatar assets for agent status', () => {
    expect(agentStatusSource).toContain(
      "var REMOTE_WIDGET_ASSET_BASE = 'https://mcp.useorgx.com/widgets/shared/';"
    );
    expect(agentStatusSource).toMatch(
      /function resolveWidgetAsset\(path\)\{\s*return REMOTE_WIDGET_ASSET_BASE \+ path;\s*\}/
    );
  });

  it('distinguishes assigned work from an actively running agent', () => {
    expect(agentStatusSource).toContain("status === 'assigned'");
    expect(agentStatusSource).toContain("return 'Assigned'");
    expect(agentStatusSource).toContain("status === 'idle' &&");
    expect(agentStatusSource).toContain("task.status === 'running' || task.status === 'queued'");
  });
});
