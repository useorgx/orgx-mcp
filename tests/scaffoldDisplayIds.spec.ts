import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('scaffolded initiative display IDs', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'public/widgets/scaffolded-initiative.html'),
    'utf8'
  );

  it('generates display IDs for initiative, workstreams, milestones, and tasks', () => {
    expect(source).toContain("display_id: makeDisplayId('INI'");
    expect(source).toContain("display_id: sectionRef || makeDisplayId('ws'");
    expect(source).toContain("display_id: milestoneRef || makeDisplayId('ms'");
    expect(source).toContain("display_id: taskRef || makeDisplayId('task'");
  });

  it('keeps ids as data for joins, never as chips in the person-facing view', () => {
    expect(source).toContain('idAttr(task.display_id, task.raw_id)');
    expect(source).toContain('idAttr(milestone.display_id, milestone.raw_id)');
    expect(source).toContain('idAttr(section.display_id, section.raw_id)');
    expect(source).toContain('idAttr(scaffold.initiative.display_id, scaffold.initiative.raw_id)');
    expect(source).not.toContain('renderIdBadge');
    expect(source).not.toContain('class="badge-id"');
  });

  it('prefers scaffold refs for display badges before falling back to generated labels', () => {
    expect(source).toContain(
      "var sectionRef = typeof section.ref === 'string' && section.ref.trim() ? section.ref.trim() : '';"
    );
    expect(source).toContain(
      "var milestoneRef = typeof milestone.ref === 'string' && milestone.ref.trim() ? milestone.ref.trim() : '';"
    );
    expect(source).toContain(
      "var taskRef = typeof task.ref === 'string' && task.ref.trim() ? task.ref.trim() : '';"
    );
  });

  it('keeps UUID-style ids for joins while preserving refs for display badges', () => {
    expect(source).toContain(
      "id: workstream && typeof workstream.id === 'string' ? workstream.id : workstream && typeof workstream.ref === 'string' ? workstream.ref : ''"
    );
    expect(source).toContain(
      "id: milestone && typeof milestone.id === 'string' ? milestone.id : milestone && typeof milestone.ref === 'string' ? milestone.ref : ''"
    );
    expect(source).toContain(
      "id: task && typeof task.id === 'string' ? task.id : task && typeof task.ref === 'string' ? task.ref : ''"
    );
  });
});
