/**
 * OrgX panel icons: one line-drawn set for where work sits (goal,
 * initiative, workstream, milestone, task) and what it produced (fourteen
 * output types in four families). 16px grid, 1.5 stroke, currentColor, so
 * an icon takes the color of the text beside it.
 *
 * Icons are decoration next to a word that already names the thing, so
 * every one is aria-hidden.
 */
(function attachPanelIcons(global) {
  'use strict';
  if (global.OrgXPanelIcons) return;

  var LEVEL = {
    goal: '<circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="3.4"/><circle cx="8" cy="8" r=".9" fill="currentColor"/>',
    initiative: '<path d="M8 1.8 14.2 8 8 14.2 1.8 8Z"/><path d="M8 5.2 10.8 8 8 10.8 5.2 8Z" fill="currentColor" stroke="none" opacity=".35"/>',
    workstream: '<path d="M2.5 4.5h7M2.5 8h11M2.5 11.5h5"/><circle cx="12" cy="4.5" r="1.2" fill="currentColor"/><circle cx="10" cy="11.5" r="1.2" fill="currentColor"/>',
    milestone: '<path d="M3.5 14.5V2"/><path d="M3.5 2.5h8.2l-1.8 2.8 1.8 2.8H3.5"/>',
    task: '<circle cx="8" cy="8" r="5.8"/><path d="m5.6 8.1 1.7 1.7 3.2-3.4"/>',
  };

  var OUTPUT = {
    code: '<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5M9 3 7 13"/>',
    doc: '<path d="M4 1.8h5.5L12.5 5v9.2H4Z"/><path d="M9.3 1.8V5h3.2M6 8h4.5M6 10.5h4.5"/>',
    image: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><circle cx="5.6" cy="6.3" r="1.2"/><path d="m2.4 12 3.8-3.6 2.6 2.4 2-1.8 3 2.8"/>',
    video: '<rect x="1.8" y="3.2" width="12.4" height="9.6" rx="2"/><path d="M6.7 5.9v4.2l3.4-2.1Z" fill="currentColor"/>',
    audio: '<path d="M2 8h1.2M4.6 5.5v5M7 3v10M9.4 5v6M11.8 6.5v3"/>',
    social: '<path d="M2.5 3.5h11v7H7l-3 2.6V10.5H2.5Z"/><path d="M5.5 6h5M5.5 8h3"/>',
    email: '<rect x="1.8" y="3.3" width="12.4" height="9.4" rx="1.8"/><path d="m2.4 4.2 5.6 4.4 5.6-4.4"/>',
    deck: '<rect x="1.8" y="2.2" width="12.4" height="8.6" rx="1.6"/><path d="M8 10.8v2.8M5.5 14.2h5M5 7.6l2-2 1.6 1.4L11 4.6"/>',
    sheet: '<rect x="1.8" y="2.3" width="12.4" height="11.4" rx="1.8"/><path d="M1.8 6h12.4M1.8 9.7h12.4M6 2.3v11.4"/>',
    report: '<path d="M2 13.8h12"/><rect x="3" y="8" width="2.4" height="4.2" rx=".6"/><rect x="6.8" y="4.5" width="2.4" height="7.7" rx=".6"/><rect x="10.6" y="6.5" width="2.4" height="5.7" rx=".6"/>',
    pipeline: '<rect x="1.4" y="2" width="4" height="3.4" rx="1"/><rect x="10.6" y="6.3" width="4" height="3.4" rx="1"/><rect x="1.4" y="10.6" width="4" height="3.4" rx="1"/><path d="M5.4 3.7h1.8c1 0 1.6.6 1.6 1.6v1.4c0 .7.5 1.3 1.3 1.3h.5M5.4 12.3h1.8c1 0 1.6-.6 1.6-1.6V9.3"/>',
    routine: '<path d="M13.6 6.4A5.8 5.8 0 0 0 2.6 6M2.4 9.6a5.8 5.8 0 0 0 11 .4"/><path d="M13.8 2.8v3.6h-3.6M2.2 13.2V9.6h3.6"/><path d="M8 5.6V8l1.6 1"/>',
    web: '<rect x="1.8" y="2.5" width="12.4" height="11" rx="1.8"/><path d="M1.8 5.6h12.4"/><circle cx="4" cy="4.05" r=".5" fill="currentColor"/><circle cx="5.7" cy="4.05" r=".5" fill="currentColor"/>',
    research: '<circle cx="7" cy="7" r="4.4"/><path d="m10.3 10.3 3.6 3.6M5.2 7h3.6"/>',
  };

  /** Which family an output type belongs to, for grouping and filters. */
  var FAMILY = {
    code: 'build', sheet: 'build', pipeline: 'build', web: 'build',
    doc: 'write', report: 'write', research: 'write', email: 'write', social: 'write', deck: 'write',
    image: 'media', video: 'media', audio: 'media',
    routine: 'routine',
  };

  /** Artifact type names OrgX and its agents use, mapped onto the fourteen. */
  var ALIASES = [
    [/^(code|pr|pull_request|patch|diff|commit|repo|script)/, 'code'],
    [/(spreadsheet|sheet|csv|table|dataset|data)/, 'sheet'],
    [/(pipeline|workflow|etl|integration|automation)/, 'pipeline'],
    [/(routine|schedule|cron|recurring|trigger)/, 'routine'],
    [/(landing|website|web|page|site|html)/, 'web'],
    [/(deck|slides|presentation|pitch)/, 'deck'],
    [/(report|dashboard|analysis|metrics|chart)/, 'report'],
    [/(research|brief|competitive|investigation)/, 'research'],
    [/(email|newsletter|outreach)/, 'email'],
    [/(social|post|tweet|thread|linkedin|launch_post)/, 'social'],
    [/(video|clip|reel)/, 'video'],
    [/(audio|podcast|voice)/, 'audio'],
    [/(image|graphic|illustration|logo|design|banner|thumbnail)/, 'image'],
    [/(doc|spec|plan|memo|copy|blog|article|prd|note|text|markdown)/, 'doc'],
  ];

  function svg(body, size, cls) {
    var px = size || 14;
    return '<svg class="pn-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 16 16" width="' + px + '" height="' + px + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  function outputKind(type) {
    var key = String(type || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!key) return null;
    if (OUTPUT[key]) return key;
    for (var i = 0; i < ALIASES.length; i += 1) if (ALIASES[i][0].test(key)) return ALIASES[i][1];
    return 'doc';
  }

  global.OrgXPanelIcons = {
    /** goal | initiative | workstream | milestone | task */
    level: function level(kind, size) { return LEVEL[kind] ? svg(LEVEL[kind], size, 'pn-ic-' + kind) : ''; },
    /** Any artifact type string; unknown types read as a document, none as nothing. */
    output: function output(type, size) { var k = outputKind(type); return k ? svg(OUTPUT[k], size, 'pn-ic-out') : ''; },
    outputKind: outputKind,
    family: function family(type) { var k = outputKind(type); return k ? FAMILY[k] : null; },
    levels: Object.keys(LEVEL),
    outputs: Object.keys(OUTPUT),
  };
})(typeof window !== 'undefined' ? window : globalThis);
