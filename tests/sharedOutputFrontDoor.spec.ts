import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { outputFrontDoor } from './fixtures/outputFrontDoor';

const source = readFileSync('public/widgets/shared/output-front-door.js', 'utf8');
function mount(value: unknown, options: Record<string, unknown> = {}) {
  const dom = new JSDOM('<!doctype html><main></main>', { runScripts: 'outside-only' });
  dom.window.eval(source);
  const renderer = (dom.window as unknown as { OrgXOutputFrontDoor: { render(value: unknown, options: unknown): string } }).OrgXOutputFrontDoor;
  dom.window.document.querySelector('main')!.innerHTML = renderer.render(value, options);
  return dom.window.document;
}

describe('shared output summary presentation', () => {
  it('leads with the answer and visible context, and keeps producer checks distinct', () => {
    const door = outputFrontDoor(), doc = mount(door, { artifactId: door.files[0]!.artifactId });
    expect(doc.querySelector('[data-front-door]')?.children[0]?.textContent).toBe('The answer');
    expect(doc.querySelector('.ox-fd-context')?.textContent).toContain('Context partial.');
    expect(doc.querySelector('.ox-fd-checks')?.textContent).toContain('Reported by the producer. Quality results and client acceptance are recorded separately below.');
    expect(doc.querySelectorAll('.ox-fd-decisions li')).toHaveLength(1);
    expect(doc.querySelector('[aria-label="Decisions"] h4')?.textContent).toBe('Linked decisions · 1 decision');
    expect(doc.querySelector('[aria-current="page"]')?.textContent).toContain('Client deck.md');
    expect(doc.querySelector('.ox-fd-receipt')?.textContent).toContain('Run cost$0.00Expert minutes0 minQuality barNot recorded');
    expect(doc.querySelectorAll('button')).toHaveLength(0);
  });

  it('escapes every source field and rejects forged routes, even with a valid ID', () => {
    const door = outputFrontDoor();
    const malicious = '<img src=x onerror="window.compromised=true">';
    const doc = mount({ ...door, answer: malicious, context: { ...door.context, summary: malicious }, checked: [malicious], files: [{ ...door.files[0], name: malicious, purpose: malicious }], decisions: [{ ...door.decisions[0], href: 'javascript:alert(1)' }], receipt: { ...door.receipt, href: 'https://evil.test', qualityBar: malicious } });
    expect(doc.querySelector('img,script,svg,iframe,[onerror]')).toBeNull();
    expect(doc.querySelector('main')?.textContent).toContain(malicious);
    expect([...doc.querySelectorAll('a')].every((a) => a.getAttribute('href')?.startsWith('https://useorgx.com/artifacts/'))).toBe(true);
    expect(doc.querySelector('.ox-fd-decisions')).toBeNull();
  });

  it('preserves small nonzero costs and collapses a large file package', () => {
    const door = outputFrontDoor();
    const doc = mount({ ...door, files: Array.from({ length: 6 }, () => door.files[0]), receipt: { ...door.receipt, costUsd: 0.001 } });
    expect(doc.querySelector('.ox-fd-receipt')?.textContent).toContain('<$0.01');
    expect(doc.querySelector('nav details summary')?.textContent).toBe('Show all 6 files');
    expect(doc.querySelectorAll('nav li')).toHaveLength(6);
  });

  it('limits decision presentation to three and never derives a mutation capability', () => {
    const door = outputFrontDoor();
    const doc = mount({ ...door, decisions: Array.from({ length: 4 }, () => door.decisions[0]) });
    expect(doc.querySelectorAll('.ox-fd-decisions li')).toHaveLength(3);
    expect(doc.querySelector('button,[data-action], [data-approval-token]')).toBeNull();
  });
});
