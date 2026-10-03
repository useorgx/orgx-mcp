// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import '../public/widgets/shared/widget-runtime.js';

interface WidgetTime {
  locale(): string;
  timeZone(): string | undefined;
  clock(value: unknown): string;
  day(value: unknown, options?: { now?: unknown }): string;
  when(value: unknown, options?: { now?: unknown }): string;
  relative(value: unknown, options?: { now?: unknown; inline?: boolean }): string;
  synced(value: unknown, options?: { now?: unknown }): string;
  full(value: unknown): string;
  html(value: unknown, mode?: string, options?: { now?: unknown }): string;
}

const runtime = (window as unknown as { OrgXWidgetRuntime: { time: WidgetTime; __resetForTests(): void } })
  .OrgXWidgetRuntime;
const time = runtime.time;
const win = window as unknown as { openai?: Record<string, unknown> };

// 2026-10-02 17:05 in UTC; the suite runs with the browser zone, so build
// local times instead of fixed UTC strings.
const at = (h: number, m: number, dayOffset = 0) => new Date(2026, 9, 2 + dayOffset, h, m, 0);
const NOW = at(17, 5);

function withLocale(locale: string) {
  win.openai = { locale };
}

describe('widget time formatter', () => {
  afterEach(() => {
    delete win.openai;
    runtime.__resetForTests();
  });

  it('reads the locale from window.openai.locale, then navigator.language', () => {
    withLocale('de-DE');
    expect(time.locale()).toBe('de-DE');
    win.openai = { locale: 'en_GB' };
    expect(time.locale()).toBe('en-GB');
    delete win.openai;
    expect(time.locale()).toBe(navigator.language);
  });

  it('formats clock times in 12h for en-US', () => {
    withLocale('en-US');
    expect(time.clock(at(17, 5))).toBe('5:05 PM');
    expect(time.clock(at(9, 30))).toBe('9:30 AM');
  });

  it('formats clock times in 24h for en-GB', () => {
    withLocale('en-GB');
    expect(time.clock(at(17, 5))).toBe('17:05');
    expect(time.clock(at(9, 30))).toBe('09:30');
  });

  it('formats clock times in 24h for de-DE', () => {
    withLocale('de-DE');
    expect(time.clock(at(17, 5))).toBe('17:05');
  });

  it('formats dates in the locale order', () => {
    withLocale('en-US');
    expect(time.day(at(12, 0, -3), { now: NOW })).toBe('Sep 29');
    expect(time.day(new Date(2025, 9, 2), { now: NOW })).toBe('Oct 2, 2025');
    withLocale('en-GB');
    expect(time.day(at(12, 0, -3), { now: NOW })).toBe('29 Sept');
    withLocale('de-DE');
    expect(time.day(at(12, 0, -3), { now: NOW })).toBe('29. Sept.');
  });

  it('keeps absolute times as short as reads unambiguously', () => {
    withLocale('en-US');
    expect(time.when(at(17, 4), { now: NOW })).toBe('5:04 PM');
    expect(time.when(at(17, 4, -1), { now: NOW })).toBe('Yesterday, 5:04 PM');
    expect(time.when(at(17, 4, -5), { now: NOW })).toBe('Sep 27, 5:04 PM');
    withLocale('de-DE');
    expect(time.when(at(17, 4, -5), { now: NOW })).toBe('27. Sept., 17:04');
  });

  it('uses relative time where it reads better', () => {
    withLocale('en-US');
    expect(time.relative(at(17, 5), { now: NOW })).toBe('Just now');
    expect(time.relative(at(17, 3), { now: NOW })).toBe('2m ago');
    expect(time.relative(at(14, 5), { now: NOW })).toBe('3h ago');
    expect(time.relative(at(13, 0), { now: NOW })).toBe('4h ago');
    // Across midnight, a calendar word reads better than a count of hours.
    expect(time.relative(at(23, 0, -1), { now: NOW })).toBe('Yesterday');
    expect(time.relative(at(9, 0, -1), { now: NOW })).toBe('Yesterday');
    expect(time.relative(at(9, 0, -1), { now: NOW, inline: true })).toBe('yesterday');
    expect(time.relative(at(9, 0, -4), { now: NOW })).toBe('4d ago');
    expect(time.relative(at(9, 0, -12), { now: NOW })).toBe('Sep 20');
    expect(time.relative(at(17, 10), { now: NOW })).toBe('in 5m');
    // 106 hours is a human "4d ago", never "106h ago".
    expect(time.relative(new Date(NOW.getTime() - 106 * 3600e3), { now: NOW })).toBe('4d ago');
  });

  it('labels sync stamps without 24h clocks in 12h locales', () => {
    withLocale('en-US');
    expect(time.synced(at(17, 1), { now: NOW })).toBe('synced 4m ago');
    expect(time.synced(at(15, 5), { now: NOW })).toBe('synced 3:05 PM');
    expect(time.synced(at(15, 5, -1), { now: NOW })).toBe('synced yesterday, 3:05 PM');
    withLocale('en-GB');
    expect(time.synced(at(15, 5), { now: NOW })).toBe('synced 15:05');
  });

  it('accepts ISO strings, epoch ms and seconds, and rejects junk', () => {
    withLocale('en-US');
    const date = at(17, 5);
    expect(time.clock(date.toISOString())).toBe('5:05 PM');
    expect(time.clock(date.getTime())).toBe('5:05 PM');
    expect(time.clock(Math.floor(date.getTime() / 1000))).toBe('5:05 PM');
    expect(time.clock('not a date')).toBe('');
    expect(time.relative(null)).toBe('');
  });

  it('renders <time> markup with the full local date in the title', () => {
    withLocale('en-US');
    const html = time.html(at(17, 3), 'relative', { now: NOW });
    expect(html).toMatch(/^<time datetime="2026-10-02T\d\d:03:00\.000Z" title="Friday, October 2, 2026 at 5:03 PM [^"]+">2m ago<\/time>$/);
  });
});
