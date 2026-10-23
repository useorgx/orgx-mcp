/** Presentation only: canonical review projections, never producer metadata or authority. */
(function attachOutputFrontDoor(global) {
  'use strict';
  if (global.OrgXOutputFrontDoor) return;
  function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function uuid(value) { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value); }
  function text(value) { return typeof value === 'string' ? value : ''; }
  function amount(value, suffix) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) + suffix : 'Not recorded'; }
  function attrs(path) { return global.OrgXLinks ? global.OrgXLinks.attrs(path) : 'href="https://useorgx.com' + esc(path) + '" data-ox-link'; }
  function link(path, label) { return '<a ' + attrs(path) + '>' + esc(label) + '</a>'; }
  function bytes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
    return value < 1024 ? value + ' B' : value < 1048576 ? Math.round(value / 1024) + ' KB' : (value / 1048576).toFixed(1) + ' MB';
  }
  function list(values) {
    var items = Array.isArray(values) ? values.filter(function valid(value) { return typeof value === 'string'; }).slice(0, 8) : [];
    return items.length ? '<ul>' + items.map(function item(value) { return '<li>' + esc(value) + '</li>'; }).join('') + '</ul>' : '<p>No producer notes.</p>';
  }
  function render(value, options) {
    options = options || {};
    if (!value || value.schemaVersion !== 'artifact_output_front_door.v1' || value.evidenceBasis !== 'producer_reported' || !text(value.answer)) return '';
    var context = value.context || {}, receipt = value.receipt || {};
    var contextState = ['loaded', 'partial', 'missing', 'unavailable', 'unknown'].indexOf(context.state) !== -1 ? context.state : 'unknown';
    var decisions = Array.isArray(value.decisions) ? value.decisions.filter(function valid(d) {
      return d && uuid(d.id) && text(d.question) && text(d.recommendation) && text(d.impact) && d.href === '/decisions/' + d.id;
    }).slice(0, 3) : [];
    var files = Array.isArray(value.files) ? value.files.filter(function valid(file) {
      return file && uuid(file.artifactId) && text(file.name) && file.href === '/artifacts/' + file.artifactId;
    }).slice(0, 100) : [];
    function fileRow(file) {
      var current = file.artifactId === options.artifactId;
      return '<li><a ' + attrs(file.href) + (current ? ' aria-current="page"' : '') + '><strong>' + esc(file.name) + '</strong><span>' + esc([text(file.mimeType) || 'File', bytes(file.sizeBytes)].filter(Boolean).join(' · ')) + '</span><span>' + esc(text(file.purpose)) + '</span></a></li>';
    }
    var fileList = files.length ? '<nav aria-label="Output files"><h4>Files</h4><ul class="ox-fd-files">' + files.slice(0, 4).map(fileRow).join('') + '</ul>' +
      (files.length > 4 ? '<details><summary>Show all ' + files.length + ' files</summary><ul class="ox-fd-files">' + files.slice(4).map(fileRow).join('') + '</ul></details>' : '') + '</nav>' : '';
    var decisionList = decisions.length ? '<section aria-label="Decisions"><h4>Needs you · ' + decisions.length + (decisions.length === 1 ? ' decision' : ' decisions') + '</h4><ol class="ox-fd-decisions">' + decisions.map(function decision(d) {
      return '<li><strong>' + esc(d.question) + '</strong><p><b>Recommend:</b> ' + esc(d.recommendation) + '</p><p>' + esc(d.impact) + '</p>' +
        (typeof options.decisionAction === 'function' ? options.decisionAction(d.id) : link(d.href, 'Review decision')) + '</li>';
    }).join('') + '</ol></section>' : '';
    var runLink = uuid(receipt.runId) && receipt.href === '/console/runs/' + receipt.runId ? link(receipt.href, 'Open run receipt') : 'Run not recorded';
    return '<section class="ox-front-door" aria-label="Output summary" data-front-door>' +
      '<h3>The answer</h3><p class="ox-fd-answer">' + esc(value.answer) + '</p>' +
      '<p class="ox-fd-context" data-state="' + contextState + '"><strong>Context ' + contextState + '.</strong> ' + esc(text(context.summary) || 'OrgX context status was not recorded for this output.') + '</p>' + decisionList +
      '<details class="ox-fd-checks"><summary>Checked / Not checked</summary><p>Reported by the producer. Quality results and client acceptance are recorded separately below.</p><h4>Checked</h4>' + list(value.checked) + '<h4>Not checked</h4>' + list(value.notChecked) + '</details>' +
      fileList + '<section class="ox-fd-receipt" aria-label="Run receipt"><h4>Run receipt</h4><dl><dt>Run cost</dt><dd>' +
      (typeof receipt.costUsd === 'number' && Number.isFinite(receipt.costUsd) && receipt.costUsd >= 0 ? receipt.costUsd > 0 && receipt.costUsd < 0.01 ? '&lt;$0.01' : '$' + receipt.costUsd.toFixed(2) : 'Not recorded') +
      '</dd><dt>Expert minutes</dt><dd>' + esc(amount(receipt.expertMinutes, ' min')) + '</dd><dt>Quality bar</dt><dd>' + esc(text(receipt.qualityBar) || 'Not recorded') + '</dd></dl><p>' + runLink + '</p></section></section>';
  }
  global.OrgXOutputFrontDoor = { render: render };
})(typeof window !== 'undefined' ? window : globalThis);
