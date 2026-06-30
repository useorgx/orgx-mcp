import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Hope UX integration walkthrough', () => {
  const html = readFileSync(resolve(process.cwd(), 'public/hope-ux.html'), 'utf8');
  const sitemap = readFileSync(resolve(process.cwd(), 'public/sitemap.xml'), 'utf8');
  const robots = readFileSync(resolve(process.cwd(), 'public/robots.txt'), 'utf8');
  const landing = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');

  it('publishes crawlable metadata and machine-readable discovery links', () => {
    expect(html).toContain('<title>Hope UX | OrgX MCP Integration Walkthrough</title>');
    expect(html).toContain('rel="canonical" href="https://mcp.useorgx.com/hope-ux"');
    expect(html).toContain('https://mcp.useorgx.com/.well-known/mcp.json');
    expect(html).toContain('https://mcp.useorgx.com/llms.txt');
    expect(html).toContain('"@type": "TechArticle"');
    expect(html).toContain('"@type": "HowTo"');
    expect(sitemap).toContain('https://mcp.useorgx.com/hope-ux');
    expect(robots).toContain('Allow: /hope-ux');
    expect(landing).toContain('https://mcp.useorgx.com/hope-ux');
  });

  it('keeps the walkthrough grounded in the integration proof sequence', () => {
    expect(html).toContain('scaffold_initiative');
    expect(html).toContain('get_initiative_pulse');
    expect(html).toContain('get_operator_chronicle');
    expect(html).toContain('orgx_submit_receipt');
    expect(html).toContain('what context arrives');
    expect(html).toContain('What each side owns');
  });

  it('uses OrgX visual primitives without nested-card language', () => {
    expect(html).toContain('--ox-primary-rgb: 99, 102, 241');
    expect(html).toContain('linear-gradient(');
    expect(html).toContain('screenshots/orgx-mcp-og.png');
    expect(html).not.toContain('card-within-card');
  });
});
