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

  it('agrees on the run-lifecycle statuses too', () => {
    const machine = scope.OrgXLiveMachine!;
    const runStatuses = [
      'EXECUTING', 'REEXECUTING', 'RUNNING', 'IN_PROGRESS', 'STREAMING',
      'COMPLETED', 'FAILED', 'CRASHED', 'CANCELED', 'EXPIRED', 'TIMED_OUT',
      'INTERRUPTED', 'SHIPPED', 'NEEDS_APPROVAL', 'AWAITING_INPUT', 'ESCALATED',
      'queued', 'pending', 'in-progress',
    ];
    for (const status of runStatuses) {
      expect(machine.phaseForStatus(status), status).toBe(serverPhaseForStatus(status));
    }
  });

  it('agrees that an unknown status is pending on both sides', () => {
    const machine = scope.OrgXLiveMachine!;
    for (const status of ['wat', '', null, undefined]) {
      expect(machine.phaseForStatus(status)).toBe(serverPhaseForStatus(status));
    }
  });
});
