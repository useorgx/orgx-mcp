import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'public/widgets/shared/markdown.js'), 'utf8');

function preview(value: string, options?: Record<string, unknown>) {
  const dom = new JSDOM('<!doctype html><main></main>', { runScripts: 'outside-only' });
  dom.window.eval(source);
  const markdown = (dom.window as unknown as { OrgXMarkdown: { render(value: string, options?: unknown): string } }).OrgXMarkdown;
  dom.window.document.querySelector('main')!.innerHTML = markdown.render(value, options);
  return dom.window.document;
}

describe('shared output Markdown', () => {
  it('renders headings, lists, inline formatting and source links as structured content', () => {
    const doc = preview('# Answer\n\n**Ship the deck.** Keep `v2`.\n\n- Brand checked\n- Data checked\n\n[Receipt](/console/runs/abc)');
    expect(doc.querySelector('h1')?.textContent).toBe('Answer');
    expect(doc.querySelector('strong')?.textContent).toBe('Ship the deck.');
    expect(doc.querySelector('code')?.textContent).toBe('v2');
    expect(doc.querySelectorAll('ul li')).toHaveLength(2);
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://useorgx.com/console/runs/abc');
    expect(doc.querySelector('a')?.hasAttribute('data-ox-link')).toBe(true);
    expect(doc.querySelector('main')?.textContent).not.toContain('**');
  });

  it('renders table headers and cell labels, stacking more than four columns on phones', () => {
    const doc = preview('| Work | Owner | Due | Result | Next |\n| --- | --- | --- | --- | --- |\n| Deck | Hope | Friday | Editable | Review |');
    expect(doc.querySelectorAll('th')).toHaveLength(5);
    expect(doc.querySelector('table')?.getAttribute('data-stack')).toBe('true');
    expect(doc.querySelector('td[data-label="Owner"]')?.textContent).toBe('Hope');
    expect(doc.querySelector('main')?.textContent).not.toContain('|');
  });

  it('preserves escaped pipes and pipes inside code cells', () => {
    const doc = preview('| Detail | Code |\n| --- | --- |\n| A\\|B | `x|y` |');
    expect([...doc.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['A|B', 'x|y']);
  });

  it('never executes raw HTML or Mermaid source in a preview', () => {
    const doc = preview('<script>window.compromised=true</script>');
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('main')?.textContent).toContain('Open the full artifact');
    const diagram = preview('```mermaid\nflowchart LR\n A[Client] --> B[Review]\n```');
    expect(diagram.querySelector('main')?.textContent).toBe('Diagram preview unavailable; a rendered file is needed.');
    expect(diagram.querySelector('main')?.textContent).not.toContain('flowchart');
  });

  it('escapes inline markup and drops executable, credential and protocol-relative links', () => {
    const doc = preview('## <img src=x onerror="alert(1)">\n\n[Bad](javascript:alert(1)) [Data](data:text/html,evil) [Host](//evil.test) [Login](https://user:secret@example.test)');
    expect(doc.querySelector('img,script,iframe,svg')).toBeNull();
    expect(doc.querySelectorAll('a')).toHaveLength(0);
    expect(doc.querySelector('h2')?.textContent).toContain('<img');
  });

  it('lets callers retain their existing outbound-origin policy', () => {
    const doc = preview('[OrgX](https://useorgx.com/artifacts/a) [Other](https://example.test)', {
      linkAllowed: (href: string) => new URL(href).origin === 'https://useorgx.com',
    });
    expect(doc.querySelectorAll('a')).toHaveLength(1);
    expect(doc.querySelector('a')?.textContent).toBe('OrgX');
  });

  it('keeps code fences inert and never interprets HTML as a code-language attribute', () => {
    const doc = preview('```html\n<img src=x onerror="alert(1)">\n```');
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('pre code')?.textContent).toContain('<img');
  });
});
