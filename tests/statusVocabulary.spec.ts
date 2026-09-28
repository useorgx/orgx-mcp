// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { phaseForStatus as serverPhaseForStatus } from '../src/live/workGraph';

/**
 * One status vocabulary across the whole client.
 *
 * shared/widget-state.js and shared/live-machine.js both run on the same page —
 * the card reads one, the live panel reads the other — so a status they
 * classify differently shows the same node in two states at once. They shipped
 * disagreeing: `waiting` was executing to one and blocked to the other, and
 * each treated most of the other's terms as unknown.
 *
 * src/live/workGraph.ts is the third copy, on the server. All three have to
 * agree or a node changes meaning as it crosses the wire.
 */

const SHARED = join(__dirname, '..', 'public', 'widgets', 'shared');

interface Scope {
  OrgXWidgetState?: {
    derive(record: unknown): { state?: string } | string | null;
    normalize(record: unknown): unknown;
  };
  OrgXLiveMachine?: {
    PHASES: Record<string, string>;
    phaseForStatus(status: unknown): string;
    phaseForRow(row: unknown): string;
  };
}

let scope: Scope;

/** The buckets widget-state.js declares, read from its source. */
function widgetStateVocabulary(): Record<string, string[]> {
  const source = readFileSync(join(SHARED, 'widget-state.js'), 'utf8');
  const read = (name: string) => {
    const match = source.match(new RegExp(`var ${name} = \\[(.*?)\\];`, 's'));
    if (!match) throw new Error(`${name} not found in widget-state.js`);
    return match[1]!
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  };
  return {
    terminal: read('TERMINAL'),
    blocked: read('BLOCKED'),
    executing: read('ACTIVE'),
    pending: read('QUEUED'),
  };
}

beforeAll(() => {
  scope = window as unknown as Scope;
  for (const file of ['widget-state.js', 'live-machine.js']) {
    window.eval(readFileSync(join(SHARED, file), 'utf8'));
  }
});

describe('live-machine covers everything widget-state knows', () => {
  const vocabulary = widgetStateVocabulary();

  for (const [phase, statuses] of Object.entries(vocabulary)) {
    it(`classifies every ${phase} status the same way`, () => {
      const machine = scope.OrgXLiveMachine!;
      for (const status of statuses) {
        expect(
          machine.phaseForStatus(status),
          `"${status}" should be ${phase}`
        ).toBe(machine.PHASES[phase.toUpperCase()]);
      }
    });
  }

  it('treats a bare "waiting" as blocked, not as running work', () => {
    // The sharpest disagreement: waiting on someone is blocked. Trigger's
    // WAITING run state means suspended-on-a-child and arrives as a lifecycle
    // boolean, which phaseForRow reads first.
    const machine = scope.OrgXLiveMachine!;
    expect(machine.phaseForStatus('waiting')).toBe(machine.PHASES.BLOCKED);
    expect(machine.phaseForRow({ isWaiting: true })).toBe(machine.PHASES.EXECUTING);
  });
});

describe('the server agrees with the client', () => {
  const vocabulary = widgetStateVocabulary();
  const everyStatus = Object.values(vocabulary).flat();

  it('classifies every known status identically on both sides', () => {
    // workGraph.ts normalizes on the server and live-machine.js re-derives on
    // the client. A node that means one thing in the Durable Object and another
    // in the widget is the failure this whole layer exists to prevent.
    const machine = scope.OrgXLiveMachine!;
    const disagreements: string[] = [];
    for (const status of everyStatus) {
      const server = serverPhaseForStatus(status);
      const client = machine.phaseForStatus(status);
      if (server !== client) disagreements.push(`${status}: server=${server} client=${client}`);
    }
    expect(disagreements).toEqual([]);
  });

  /**
   * Statuses widget-state does not declare, so the table above never reaches
   * them: Trigger's run lifecycle, and the separator spellings an upstream can
   * send for the same word. Each row states the phase it must resolve to, so a
   * failure names the expected answer rather than only reporting a mismatch.
   */
  const RUN_LIFECYCLE: [status: string, phase: string][] = [
    ['EXECUTING', 'executing'],
    ['REEXECUTING', 'executing'],
    ['RUNNING', 'executing'],
    ['IN_PROGRESS', 'executing'],
    ['STREAMING', 'executing'],
    // Separator spellings normalize to the same phase: space, hyphen, underscore.
    ['in progress', 'executing'],
    ['in-progress', 'executing'],
    ['COMPLETED', 'terminal'],
    ['FAILED', 'terminal'],
    ['CRASHED', 'terminal'],
    ['CANCELED', 'terminal'],
    ['EXPIRED', 'terminal'],
    ['TIMED_OUT', 'terminal'],
    ['INTERRUPTED', 'terminal'],
    ['SHIPPED', 'terminal'],
    ['NEEDS_APPROVAL', 'blocked'],
    ['AWAITING_INPUT', 'blocked'],
    ['ESCALATED', 'blocked'],
    ['queued', 'pending'],
    ['pending', 'pending'],
  ];

  it.each(RUN_LIFECYCLE)('classifies %s as %s on both sides', (status, phase) => {
    const machine = scope.OrgXLiveMachine!;
    expect(machine.phaseForStatus(status), `client: ${status}`).toBe(phase);
    expect(serverPhaseForStatus(status), `server: ${status}`).toBe(phase);
  });

  it('agrees that an unknown status is pending on both sides', () => {
    const machine = scope.OrgXLiveMachine!;
    for (const status of ['wat', '', null, undefined]) {
      expect(machine.phaseForStatus(status)).toBe(serverPhaseForStatus(status));
    }
  });
});
