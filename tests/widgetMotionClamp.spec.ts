// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readWidgetSource } from './fixtures/live';

import { afterEach, describe, expect, it, vi } from 'vitest';

import '../public/widgets/shared/widget-runtime.js';

/**
 * motion.setClamped: "Show full section" (plan-session-live) and "All
 * evidence" (orgx-panel) animate between the clamped preview and the whole
 * block instead of snapping; reduced motion switches instantly.
 */
type Motion = {
  setClamped(el: HTMLElement, clamped: boolean, trigger?: HTMLElement | null, options?: Record<string, unknown>): Promise<void>;
};
const motion = (window as unknown as { OrgXWidgetRuntime: { motion: Motion } }).OrgXWidgetRuntime.motion;

function block(): { el: HTMLElement; trigger: HTMLButtonElement; extra: HTMLElement[] } {
  document.body.innerHTML = '<button id="t">Show</button><ul id="l"><li>a</li><li>b</li><li>c</li><li>d</li></ul>';
  const el = document.getElementById('l')!;
  // jsdom has no layout: the clamp decides the height.
  el.getBoundingClientRect = () => ({ height: el.getAttribute('data-ox-clamped') === 'true' ? 80 : 200 }) as DOMRect;
  return { el, trigger: document.getElementById('t') as HTMLButtonElement, extra: Array.from(el.children).slice(2) as HTMLElement[] };
}

function reduceMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({ matches: reduce }) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('motion.setClamped', () => {
  it('animates the height from the preview to the whole block, then back', async () => {
    reduceMotion(false);
    const { el, trigger, extra } = block();
    await motion.setClamped(el, true, trigger, { max: 80, beyond: extra, instant: true });
    expect(el.style.maxHeight).toBe('80px');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(extra.every((item) => item.hasAttribute('inert') && item.getAttribute('aria-hidden') === 'true')).toBe(true);

    const frames: unknown[] = [];
    el.animate = vi.fn((keyframes: unknown) => {
      frames.push(keyframes);
      const animation = { onfinish: null as null | (() => void), oncancel: null, cancel: vi.fn() };
      queueMicrotask(() => animation.onfinish?.());
      return animation as unknown as Animation;
    }) as unknown as typeof el.animate;

    await motion.setClamped(el, false, trigger, { max: 80, beyond: extra });
    expect(frames[0]).toEqual([
      { height: '80px', maxHeight: 'none' },
      { height: '200px', maxHeight: 'none' },
    ]);
    expect(el.style.maxHeight).toBe('');
    expect(el.getAttribute('data-ox-clamped')).toBe('false');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(extra.some((item) => item.hasAttribute('inert'))).toBe(false);

    await motion.setClamped(el, true, trigger, { max: 80, beyond: extra, expandedClass: 'is-expanded' });
    expect(frames[1]).toEqual([
      { height: '200px', maxHeight: 'none' },
      { height: '80px', maxHeight: 'none' },
    ]);
    expect(el.classList.contains('is-expanded')).toBe(false);
  });

  it('switches instantly under reduced motion', async () => {
    reduceMotion(true);
    const { el, trigger } = block();
    el.animate = vi.fn() as unknown as typeof el.animate;
    await motion.setClamped(el, false, trigger, { expandedClass: 'is-expanded' });
    expect(el.animate).not.toHaveBeenCalled();
    expect(el.classList.contains('is-expanded')).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('is what plan-session-live and orgx-panel use for their disclosures', () => {
    const read = (name: string) => readFileSync(resolve(__dirname, `../public/widgets/${name}.html`), 'utf8');
    expect(read('plan-session-live')).toContain("motion.setClamped(wrap, expanded, expand, { expandedClass: 'is-expanded' })");
    const panel = readWidgetSource('orgx-panel');
    expect(panel).toContain('R.motion.setClamped(list, clamped, toggle, options)');
    expect(panel).not.toContain("case 'evidence': ui.evidenceOpen = !ui.evidenceOpen; render();");
  });
});
