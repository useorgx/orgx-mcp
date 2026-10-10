// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mountPanel, snapshot } from './fixtures/panel';

/**
 * The cold-start stage, the real OrgX mark on every avatar that stands for
 * OrgX itself, and the rail of ways in on the calm state.
 */
type Mounted = Awaited<ReturnType<typeof mountPanel>>;
const mounted: Mounted[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));
const doc = (m: Mounted) => m.dom.window.document;
const click = (m: Mounted, selector: string) => (doc(m).querySelector(selector) as HTMLElement).click();

function calm() {
  return snapshot({
    attention: { pending: 0, oldest_at: null, blocking: false }, queue: [], focus: null,
    proof: { last_accepted: { title: 'Release checklist v3', accepted_at: '2026-10-01T12:00:00.000Z', url: 'https://useorgx.com/a' }, completed_unaccepted: 0 },
  });
}

describe('cold start', () => {
  it('shows the mark in orbit with the caption, then the content takes its place', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    const stage = doc(m).querySelector('.pn-skel .pn-boot')!;
    expect(stage).not.toBeNull();
    expect(stage.querySelectorAll('.pn-boot-sat').length).toBe(4);
    expect((stage.querySelector('.pn-boot-mark img') as HTMLImageElement).getAttribute('src')).toMatch(/^data:image\/webp;base64,/);
    expect(stage.querySelector('.sk-cap')!.textContent).toBe('Reading your workspace');
    expect(doc(m).getElementById('panel')!.getAttribute('aria-busy')).toBe('true');
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    expect(doc(m).querySelector('.pn-boot')).toBeNull();
    expect(doc(m).querySelector('#pk-q')!.textContent).toBe('Ship release 4.2?');
  });
});

describe('the OrgX mark', () => {
  it('is the real mark, not a drawing, wherever an avatar stands for OrgX itself', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    const avatars = Array.from(doc(m).querySelectorAll('ox-avatar')) as (HTMLElement & { shadowRoot: ShadowRoot })[];
    const marks = avatars.filter((a) => a.shadowRoot?.querySelector('.a')?.getAttribute('data-kind') === 'mark');
    expect(marks.length).toBeGreaterThan(0);
    for (const a of marks) {
      const img = a.shadowRoot.querySelector('.f img.ox-mark') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(img.getAttribute('src')).toMatch(/^data:image\/webp;base64,/);
      // The kit's stylesheet hides a mark avatar's <img>; the real mark must still show.
      expect(img.style.display).toBe('block');
      expect(a.shadowRoot.querySelector('.f svg')).toBeNull();
    }
  });
});

describe('ways in when nothing needs you', () => {
  it('offers a rail of jobs, and a tap opens Start with the words in the box', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: calm() });
    await m.flush();
    const chips = Array.from(doc(m).querySelectorAll('.pn-calm .cm-rail .st-idea'));
    expect(chips.length).toBe(4);
    expect(chips[0]!.textContent).toBe('Draft the launch post for the new pricing');
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('needs');
    click(m, '.pn-calm .cm-rail .st-idea');
    await m.flush();
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('start');
    expect((doc(m).querySelector('#st-text') as HTMLTextAreaElement).value).toBe('Draft the launch post for the new pricing');
    expect(doc(m).querySelector('.st-preview')!.textContent).toContain('In OrgX, hand this to Mark (Marketing): Draft the launch post for the new pricing.');
  });
});
