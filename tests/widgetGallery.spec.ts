import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('widget gallery state contract', () => {
  const gallerySource = readFileSync(
    resolve(process.cwd(), 'public/widgets/index.html'),
    'utf8'
  );
  const taskSource = readFileSync(
    resolve(process.cwd(), 'public/widgets/task-spawned.html'),
    'utf8'
  );

  it('exposes the core operating states in the QA workbench', () => {
    expect(gallerySource).toContain('value="progressing">In progress');
    expect(gallerySource).toContain('value="completed">Completed');
    expect(gallerySource).toContain('value="blocked">Blocked');
    expect(gallerySource).toContain('value="stale">Needs refresh');
    expect(gallerySource).toContain('State contract');
  });

  it('maps the task card to an honest state-specific headline and action', () => {
    expect(taskSource).toContain('Execution complete');
    expect(taskSource).toContain('Execution In Progress');
    expect(taskSource).toContain('Execution Needs Refresh');
    expect(taskSource).toContain("stateMeta.state === 'completed' ? 'View result'");
  });
  it('keeps gallery fixtures deterministic and link-safe', () => {
    expect(gallerySource).toContain("gallery=true");
    expect(taskSource).not.toContain("url: '#'");
    const searchSource = readFileSync(
      resolve(process.cwd(), 'public/widgets/search-results.html'),
      'utf8'
    );
    expect(searchSource).not.toContain("url: '#'");
  });

  it('covers state-aware readout and stream fixtures', () => {
    const pulseSource = readFileSync(
      resolve(process.cwd(), 'public/widgets/initiative-pulse.html'),
      'utf8'
    );
    const dailySource = readFileSync(
      resolve(process.cwd(), 'public/widgets/daily-brief.html'),
      'utf8'
    );
    const streamSource = readFileSync(
      resolve(process.cwd(), 'public/widgets/scaffold-streaming.html'),
      'utf8'
    );
    expect(pulseSource).toContain('var demoState = params.get("state")');
    expect(dailySource).toContain('function buildDemoData(state)');
    expect(streamSource).toContain('function showDemoState(mode)');
  });

});
