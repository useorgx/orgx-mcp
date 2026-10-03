// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import '../public/widgets/shared/agent-identity.js';
import '../public/widgets/shared/widget-runtime.js';
import '../public/widgets/shared/orgx-icons.js';

interface Identity {
  resolveAgentKey(...values: unknown[]): string | null;
  profile(...values: unknown[]): { key: string; name: string; role: string } | null;
  isSystem(value: unknown): boolean;
  avatar(options: Record<string, unknown>): string;
  agentCard(options: Record<string, unknown>): string;
}
interface Icons {
  icon(name: string, options?: number | { size?: number; label?: string; className?: string }): string;
  forEntity(type: string): string | null;
  forStatus(status: string): string;
  names: string[];
}

const identity = (window as unknown as { OrgXAgentIdentity: Identity }).OrgXAgentIdentity;
const icons = (window as unknown as { OrgXIcons: Icons }).OrgXIcons;

function el(html: string): Element {
  const box = document.createElement('div');
  box.innerHTML = html;
  return box.firstElementChild!;
}

describe('agent identity', () => {
  it('resolves agents by key, name, id, domain or headshot stem', () => {
    expect(identity.resolveAgentKey('Engineering-Agent')).toBe('eli');
    expect(identity.resolveAgentKey('launch_captain')).toBe('mark');
    expect(identity.resolveAgentKey('Developer')).toBeNull();
    expect(identity.profile('ops')).toEqual({ key: 'orion', name: 'Orion', role: 'Operations' });
  });

  it('treats OrgX, system, automation and no owner as OrgX', () => {
    for (const v of ['OrgX', 'OrgX System', 'system', 'automatic', '', null, undefined]) expect(identity.isSystem(v)).toBe(true);
    expect(identity.isSystem('Ada Lovelace')).toBe(false);
  });

  it('never renders an empty avatar: photo for agents, the OrgX mark for system, initials for people', () => {
    const agent = el(identity.avatar({ agent: 'engineering_agent', size: 28 }));
    expect(agent.tagName).toBe('OX-AVATAR');
    expect(agent.getAttribute('agent')).toBe('eli');
    expect(agent.getAttribute('name')).toBe('Eli');
    expect(agent.getAttribute('size')).toBe('28');
    // Never smaller than inline (28 px), so a headshot stays a face; presets pass through.
    expect(el(identity.avatar({ agent: 'eli', size: 20 })).getAttribute('size')).toBe('inline');
    expect(el(identity.avatar({ agent: 'eli', size: 'row' })).getAttribute('size')).toBe('row');
    const system = el(identity.avatar({ name: 'OrgX System' }));
    expect(system.getAttribute('agent')).toBe('system');
    expect(system.getAttribute('name')).toBe('OrgX');
    expect(el(identity.avatar({})).getAttribute('agent')).toBe('system');
    const person = el(identity.avatar({ name: 'Ada Lovelace' }));
    expect(person.hasAttribute('agent')).toBe(false);
    expect(person.getAttribute('name')).toBe('Ada Lovelace');
  });

  it('wraps agents in <ox-agent-card> with role, state, task, time and the agent desk link', () => {
    const now = Date.now();
    const card = el(
      identity.agentCard({ agent: 'Eli', state: 'running', task: 'Run "the" <checks>', updatedAt: now - 120_000, label: '<b>Eli</b>' }),
    );
    expect(card.tagName).toBe('OX-AGENT-CARD');
    expect(card.getAttribute('agent')).toBe('eli');
    expect(card.getAttribute('role')).toBe('Engineering');
    expect(card.getAttribute('state')).toBe('running');
    expect(card.getAttribute('task')).toBe('Run "the" <checks>');
    expect(card.getAttribute('detail')).toBe('updated 2m ago');
    expect(card.getAttribute('href')).toBe('https://useorgx.com/command/agents/eli');
    expect(card.innerHTML).toBe('<b>Eli</b>');
  });

  it('falls back to the plain avatar for people and OrgX', () => {
    expect(identity.agentCard({ name: 'Ada Lovelace', label: 'Ada' })).toBe('<ox-avatar size="inline" name="Ada Lovelace"></ox-avatar>Ada');
    expect(identity.agentCard({ agent: 'system' })).toContain('agent="system"');
  });
});

describe('OrgX icon set', () => {
  it('covers entity types, statuses and actions', () => {
    for (const name of ['initiative', 'workstream', 'milestone', 'task', 'decision', 'artifact', 'run', 'plan', 'agent', 'search']) {
      expect(icons.forEntity(name)).toBe(name);
    }
    for (const name of ['done', 'active', 'needs-you', 'blocked', 'waiting', 'failed', 'paused', 'draft', 'open-external', 'expand', 'retry', 'filter', 'time', 'cost']) {
      expect(icons.names).toContain(name);
    }
  });

  it('draws every icon on the 24 grid with the kit stroke, decorative by default', () => {
    for (const name of icons.names) {
      const svg = el(icons.icon(name));
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('stroke-width')).toBe('1.8');
      expect(svg.getAttribute('stroke-linecap')).toBe('round');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('width')).toBe('16');
    }
    const labelled = el(icons.icon('blocked', { size: 14, label: 'Blocked' }));
    expect(labelled.getAttribute('role')).toBe('img');
    expect(labelled.getAttribute('aria-label')).toBe('Blocked');
    expect(labelled.getAttribute('width')).toBe('14');
  });

  it('draws the task icon as a work card, not a checkbox', () => {
    const task = icons.icon('task');
    // No tick mark: the old glyph was a rounded square with a check path.
    expect(task).not.toMatch(/M9 12\.2|l2 2|check/i);
    expect(task).toContain('<rect x="3" y="5" width="18" height="14"');
  });

  it('maps payload spellings and statuses, and renders nothing for unknown names', () => {
    expect(icons.forEntity('Workstream')).toBe('workstream');
    expect(icons.forEntity('agent_run')).toBe('run');
    expect(icons.forEntity('plan_session')).toBe('plan');
    expect(icons.forStatus('In progress')).toBe('active');
    expect(icons.forStatus('needs_review')).toBe('needs-you');
    expect(icons.forStatus('Blocked')).toBe('blocked');
    expect(icons.forStatus('something else')).toBe('draft');
    expect(icons.icon('ext')).toContain('data-icon="open-external"');
    expect(icons.icon('nope')).toBe('');
  });
});
