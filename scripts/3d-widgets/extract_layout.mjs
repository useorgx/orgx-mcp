#!/usr/bin/env node
/**
 * extract_layout.mjs — capture a widget's DOM as a structured layout JSON
 * the Blender builder can consume.
 *
 * For every visible element under `.shell` (the widget root), we record:
 *   - bounding box relative to the shell, in CSS px
 *   - DOM depth (used for z-stacking)
 *   - computed style: backgrounds, borders, color, font, gradients, shadows
 *   - text content for leaf nodes
 *   - SVG paths for icon nodes
 *   - referenced image URL for avatars
 *
 * Usage:
 *   node --import tsx scripts/3d-widgets/extract_layout.mjs \
 *        --widget=scaffold --out=public/widgets-3d/scaffold.layout.json
 *
 * Each widget config lives in `WIDGETS` below. Add a new entry there and the
 * pipeline picks it up — no other changes required.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { parseArgs } from 'node:util';

const ROOT = resolve(process.cwd());

// ── Widget catalogue ────────────────────────────────────────────────────────
// Each widget supplies: how to obtain a populated HTML page (via TS source +
// query string), the viewport size, and the wait time for the demo loop.
const WIDGETS = {
  scaffold: {
    builder: 'src/scaffoldWidget.ts',
    fn: 'buildScaffoldWidget',
    args: {
      sessionId: 'demo',
      streamBaseUrl: 'http://localhost:9099',
      initiativeTitle: 'OrgX Production Launch',
      liveUrl: 'https://useorgx.com/live/demo',
    },
    demo: true,                              // append ?demo=true
    rootSelector: '.shell',
    viewport: { width: 720, height: 1500 },
    settleMs: 11000,                         // demo loop runtime
  },
  'agent-status': {
    builder: 'src/liveFeedWidget.ts',
    fn: 'buildLiveFeedWidget',
    args: {
      feedType: 'agent-status',
      feedId: 'demo',
      streamBaseUrl: 'http://localhost:9099',
      streamToken: 'demo',
      liveUrl: 'https://useorgx.com/live/demo',
      title: 'Agent Status',
    },
    demo: true,
    rootSelector: '.card, body > div',
    viewport: { width: 720, height: 1500 },
    settleMs: 9000,
  },
  'initiative-pulse': {
    builder: 'src/liveFeedWidget.ts',
    fn: 'buildLiveFeedWidget',
    args: {
      feedType: 'initiative-pulse',
      feedId: 'demo',
      streamBaseUrl: 'http://localhost:9099',
      streamToken: 'demo',
      liveUrl: 'https://useorgx.com/live/demo',
      title: 'Initiative Pulse',
    },
    demo: true,
    rootSelector: '.card, body > div',
    viewport: { width: 720, height: 1500 },
    settleMs: 9000,
  },
};

// ── CLI ─────────────────────────────────────────────────────────────────────
const { values: argv } = parseArgs({
  options: {
    widget: { type: 'string', default: 'scaffold' },
    out:    { type: 'string' },
    theme:  { type: 'string', default: 'dark' },  // dark | light
    serve:  { type: 'string', default: 'http://localhost:9099' },
  },
});
const W = WIDGETS[argv.widget];
if (!W) {
  console.error(`Unknown widget: ${argv.widget}. Known: ${Object.keys(WIDGETS).join(', ')}`);
  process.exit(1);
}
const outPath = argv.out ?? join(ROOT, 'public/widgets-3d', `${argv.widget}.layout.json`);
mkdirSync(dirname(outPath), { recursive: true });

// ── Build HTML by calling the TS builder via dynamic import ────────────────
const mod = await import(join(ROOT, W.builder));
if (typeof mod[W.fn] !== 'function') {
  throw new Error(`Builder ${W.fn} not exported from ${W.builder}`);
}
const html = mod[W.fn](W.args);

// Stage HTML alongside output JSON so the page can serve from the static dir.
const stagedDir = join(ROOT, 'public', 'widgets-3d');
const stagedHtmlName = `${argv.widget}-fresh.html`;
const stagedHtmlPath = join(stagedDir, stagedHtmlName);
writeFileSync(stagedHtmlPath, html);

const url = `${argv.serve}/widgets-3d/${stagedHtmlName}${W.demo ? '?demo=true' : ''}`;

function htmlShotName(widget, theme) {
  const suffix = theme === 'light' ? '_light' : '';
  if (widget === 'scaffold') return `scaffold_widget_html${suffix}.png`;
  if (widget === 'agent-status') return `agent_status_html${suffix}.png`;
  if (widget === 'initiative-pulse') return `initiative_pulse_html${suffix}.png`;
  return `${widget}_html${suffix}.png`;
}

// ── Launch browser and walk the DOM ─────────────────────────────────────────
const browser = await chromium.launch();
const ctx = await browser.newContext({
  colorScheme: argv.theme,
  viewport: W.viewport,
  deviceScaleFactor: 1,                  // we want CSS px, not device px
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'load' });
await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), argv.theme);
await page.waitForTimeout(W.settleMs);

const rootLocator = page.locator(W.rootSelector).first();
const referenceImage = join(stagedDir, htmlShotName(argv.widget, argv.theme));
await rootLocator.screenshot({ path: referenceImage, omitBackground: false });

const tree = await page.evaluate((rootSel) => {
  // Find the root element
  let root = null;
  for (const sel of rootSel.split(',').map(s => s.trim())) {
    root = document.querySelector(sel);
    if (root) break;
  }
  if (!root) return { error: 'root_not_found' };

  const rootRect = root.getBoundingClientRect();

  // Helpers
  const parseRgb = (s) => {
    if (!s) return null;
    const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
    if (!m) return null;
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] != null ? +m[4] : 1 };
  };
  const parseShadow = (s) => {
    if (!s || s === 'none') return [];
    // Match `inset? Xpx Ypx Zpx (W?px)? rgba(…)`
    const re = /(inset\s+)?(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px(?:\s+(-?\d+(?:\.\d+)?)px)?\s+(rgba?\([^)]+\))/g;
    const out = [];
    let m;
    while ((m = re.exec(s))) {
      out.push({
        inset: !!m[1],
        x: +m[2], y: +m[3], blur: +m[4], spread: m[5] != null ? +m[5] : 0,
        color: parseRgb(m[6]),
      });
    }
    return out;
  };
  const parseGradient = (s) => {
    if (!s || !s.startsWith('linear-gradient')) return null;
    // linear-gradient(180deg, rgba(0,201,167,.05), transparent 40%)
    const inner = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
    // Split on commas that aren't inside parentheses
    const parts = [];
    let depth = 0, last = 0;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '(') depth++;
      else if (inner[i] === ')') depth--;
      else if (inner[i] === ',' && depth === 0) {
        parts.push(inner.slice(last, i).trim());
        last = i + 1;
      }
    }
    parts.push(inner.slice(last).trim());
    let angle = 0;
    let stops = parts;
    if (/^-?\d+(\.\d+)?(deg|rad|turn)$/.test(parts[0]) || parts[0].startsWith('to ')) {
      const a = parts[0];
      stops = parts.slice(1);
      if (/deg$/.test(a)) angle = parseFloat(a);
      else if (/rad$/.test(a)) angle = parseFloat(a) * 180 / Math.PI;
      else if (/turn$/.test(a)) angle = parseFloat(a) * 360;
      else if (a === 'to top') angle = 0;
      else if (a === 'to right') angle = 90;
      else if (a === 'to bottom') angle = 180;
      else if (a === 'to left') angle = 270;
    }
    const parsed = stops.map((p) => {
      const m = p.match(/^(.+?)(?:\s+(-?\d+(?:\.\d+)?)(%|px))?$/);
      const colorRaw = m ? m[1].trim() : p;
      const color = colorRaw === 'transparent'
        ? { r: 0, g: 0, b: 0, a: 0 }
        : parseRgb(colorRaw);
      const pos = m && m[2] != null
        ? (m[3] === '%' ? +m[2] / 100 : null)
        : null;
      return { color, pos };
    });
    return { angle, stops: parsed };
  };

  // Build path-based stable id for a node (e.g. shell>div.hero>span.eyebrow)
  const idFor = (el) => {
    const stack = [];
    let n = el;
    while (n && n !== root.parentElement) {
      const cls = n.className && typeof n.className === 'string' && n.className.length
        ? '.' + n.className.split(/\s+/).filter(Boolean).join('.')
        : '';
      const sib = Array.from(n.parentElement?.children ?? []).filter(c => c.tagName === n.tagName);
      const idx = sib.length > 1 ? `:${sib.indexOf(n)}` : '';
      stack.unshift(`${n.tagName.toLowerCase()}${cls}${idx}`);
      n = n.parentElement;
      if (n === root) { stack.unshift('shell'); break; }
    }
    return stack.join('>');
  };

  // SVG path extraction. We capture both:
  //   - structured `paths` (parsed element list — useful for stroke-dashoffset
  //     introspection on progress rings)
  //   - full `outerHTML` so the Blender builder can pipe it directly into
  //     bpy.ops.import_curve.svg() with no reconstruction.
  const svgFor = (el) => {
    if (el.tagName.toLowerCase() !== 'svg') return null;
    const paths = Array.from(el.querySelectorAll('path,circle,line,polyline,polygon,rect'))
      .map(p => ({ tag: p.tagName.toLowerCase(), attrs: Object.fromEntries(Array.from(p.attributes).map(a => [a.name, a.value])) }));
    const vb = el.getAttribute('viewBox');
    const cs = getComputedStyle(el);
    return {
      paths,
      viewBox: vb ? vb.split(/\s+/).map(Number) : [0, 0, 24, 24],
      stroke: parseRgb(cs.stroke),
      fill: parseRgb(cs.fill),
      strokeWidth: parseFloat(el.getAttribute('stroke-width') || cs.strokeWidth) || 1.5,
      // Outer markup, with computed colors inlined so the standalone SVG is
      // self-contained when Blender imports it without page CSS.
      outerHTML: el.outerHTML,
      computedColor: parseRgb(cs.color),    // currentColor resolves to this
    };
  };

  const isLeafText = (el) =>
    el.children.length === 0 && (el.textContent || '').trim().length > 0;

  const isVisible = (el, st) => {
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) return false;
    return true;
  };

  // Text content limited to leaves. Containers report only own structural
  // properties; the text is owned by the deepest descendant.
  const collect = [];
  const walk = (el, depth) => {
    const st = getComputedStyle(el);
    if (!isVisible(el, st)) return;
    const r = el.getBoundingClientRect();

    const node = {
      id: idFor(el),
      tag: el.tagName.toLowerCase(),
      classes: (el.className && typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : []),
      depth,
      rect: {
        x: r.left - rootRect.left,
        y: r.top  - rootRect.top,
        w: r.width,
        h: r.height,
      },
      style: {
        backgroundColor: parseRgb(st.backgroundColor),
        backgroundImage: st.backgroundImage && st.backgroundImage !== 'none' ? st.backgroundImage : null,
        backgroundGradient: parseGradient(st.backgroundImage),
        color: parseRgb(st.color),
        borderTop:    { width: parseFloat(st.borderTopWidth)    || 0, color: parseRgb(st.borderTopColor) },
        borderRight:  { width: parseFloat(st.borderRightWidth)  || 0, color: parseRgb(st.borderRightColor) },
        borderBottom: { width: parseFloat(st.borderBottomWidth) || 0, color: parseRgb(st.borderBottomColor) },
        borderLeft:   { width: parseFloat(st.borderLeftWidth)   || 0, color: parseRgb(st.borderLeftColor) },
        borderRadius: {
          tl: parseFloat(st.borderTopLeftRadius)     || 0,
          tr: parseFloat(st.borderTopRightRadius)    || 0,
          br: parseFloat(st.borderBottomRightRadius) || 0,
          bl: parseFloat(st.borderBottomLeftRadius)  || 0,
        },
        boxShadow: parseShadow(st.boxShadow),
        opacity: +st.opacity,
        fontFamily: st.fontFamily,
        fontSize: parseFloat(st.fontSize),
        fontWeight: parseFloat(st.fontWeight) || 400,
        letterSpacing: parseFloat(st.letterSpacing) || 0,
        textTransform: st.textTransform,
        textAlign: st.textAlign,
      },
    };

    // CSS custom properties relevant to widgets (e.g. --ws-rgb on cards).
    const cssVars = {};
    for (const k of ['--ws-rgb', '--ox-primary', '--ox-primary-rgb']) {
      const v = el.style.getPropertyValue(k);
      if (v) cssVars[k] = v;
    }
    if (Object.keys(cssVars).length) node.cssVars = cssVars;

    if (isLeafText(el)) node.text = (el.textContent || '').trim();

    if (el.tagName.toLowerCase() === 'svg') node.svg = svgFor(el);

    // <img> avatars
    const img = el.tagName.toLowerCase() === 'img' ? el : el.querySelector(':scope > img');
    if (img && img.src) node.imageUrl = img.src;

    collect.push(node);
    for (const child of el.children) walk(child, depth + 1);
  };
  walk(root, 0);

  return {
    rootSize: { w: rootRect.width, h: rootRect.height },
    nodes: collect,
  };
}, W.rootSelector);

await browser.close();

if (tree.error) {
  console.error(`extract failed: ${tree.error}`);
  process.exit(2);
}

const layout = {
  widget: argv.widget,
  theme: argv.theme,
  capturedAt: new Date().toISOString(),
  referenceImage: referenceImage.replace(`${ROOT}/`, ''),
  rootSize: tree.rootSize,
  nodeCount: tree.nodes.length,
  nodes: tree.nodes,
};
writeFileSync(outPath, JSON.stringify(layout, null, 2));
console.log(`✓ ${argv.widget}/${argv.theme} → ${outPath} (${tree.nodes.length} nodes, ${tree.rootSize.w.toFixed(0)}×${tree.rootSize.h.toFixed(0)}px)`);
