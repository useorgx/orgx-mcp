/** Small, inert Markdown preview shared by OrgX output surfaces. No raw HTML,
 * external embeds, event handlers or diagram code are executed. */
(function attachMarkdown(global) {
  'use strict';
  if (global.OrgXMarkdown) return;

  function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeHref(value, allowed) {
    var href = String(value || '').trim();
    // No protocol-relative URLs, controls, credentials, data or executable schemes.
    if (!href || /[\u0000-\u0020\u007f-\u009f\\]/.test(href) || href.slice(0, 2) === '//') return null;
    if (!/^(?:https:\/\/|\/(?!\/)|#)/i.test(href)) return null;
    try {
      var parsed = new URL(href, 'https://useorgx.com');
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
      if (typeof allowed === 'function' && !allowed(parsed.href)) return null;
      return href[0] === '#' ? href : parsed.href;
    } catch (_) { return null; }
  }

  function inline(source, options) {
    var text = String(source || '');
    var tokens = [];
    function token(value) { var id = tokens.length; tokens.push(value); return '\u0000MD' + id + '\u0000'; }
    // Reserve generated markup before escaping all source content.
    text = text.replace(/\u0000/g, '');
    text = text.replace(/`([^`\n]+)`/g, function code(_, value) { return token('<code>' + esc(value) + '</code>'); });
    text = text.replace(/!?\[([^\[\]\n]{1,1000})\]\(([^\s)]{1,2048})\)/g, function link(_, label, target) {
      var href = safeHref(target, options && options.linkAllowed);
      return token(href ? '<a href="' + esc(href) + '" data-ox-link rel="noopener noreferrer">' + esc(label) + '</a>' : esc(label));
    });
    text = esc(text)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    return text.replace(/\u0000MD(\d+)\u0000/g, function restore(_, index) { return tokens[Number(index)] || ''; });
  }

  function cells(line) {
    var text = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    var output = [], cell = '', escaped = false, code = false;
    for (var i = 0; i < text.length; i += 1) {
      var char = text[i];
      if (escaped) { cell += char; escaped = false; }
      else if (char === '\\') escaped = true;
      else if (char === '`') { code = !code; cell += char; }
      else if (char === '|' && !code) { output.push(cell.trim()); cell = ''; }
      else cell += char;
    }
    if (escaped) cell += '\\';
    output.push(cell.trim());
    return output;
  }

  function tableDivider(line) {
    var values = cells(line);
    return values.length > 1 && values.every(function dash(value) { return /^:?-{3,}:?$/.test(value); });
  }

  function render(source, options) {
    var text = String(source || '').replace(/\r\n?/g, '\n').slice(0, 100000);
    if (/^\s*<(?:!doctype|[a-z][a-z0-9:-]*)(?:\s|\/?>)/i.test(text)) {
      return '<p class="ox-md-note">Open the full artifact to view this HTML file.</p>';
    }
    var lines = text.split('\n'), result = [], paragraph = [], list = [], listKind = '';
    function flushParagraph() {
      if (paragraph.length) result.push('<p>' + inline(paragraph.join(' '), options) + '</p>');
      paragraph = [];
    }
    function flushList() {
      if (list.length) result.push('<' + listKind + '>' + list.map(function item(value) {
        return '<li>' + inline(value, options) + '</li>';
      }).join('') + '</' + listKind + '>');
      list = []; listKind = '';
    }
    function flush() { flushParagraph(); flushList(); }
    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index], trimmed = line.trim();
      if (!trimmed) { flush(); continue; }
      var fence = trimmed.match(/^(`{3,}|~{3,})([\w-]*)\s*$/);
      if (fence) {
        flush(); var code = [];
        var close = new RegExp('^' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
        while (++index < lines.length && !close.test(lines[index].trim())) code.push(lines[index]);
        result.push(fence[2].toLowerCase() === 'mermaid'
          ? '<p class="ox-md-note">Diagram preview unavailable; a rendered file is needed.</p>'
          : '<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (index + 1 < lines.length && line.indexOf('|') !== -1 && tableDivider(lines[index + 1])) {
        flush(); var headers = cells(line), rows = []; index += 2;
        while (index < lines.length && lines[index].trim() && lines[index].indexOf('|') !== -1) {
          rows.push(cells(lines[index])); index += 1;
        }
        index -= 1;
        result.push('<div class="ox-md-table"><table' + (headers.length > 4 ? ' data-stack="true"' : '') + '><thead><tr>' +
          headers.map(function header(value) { return '<th scope="col">' + inline(value, options) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + rows.map(function row(values) {
            return '<tr>' + headers.map(function cell(label, n) {
              return '<td data-label="' + esc(label) + '">' + inline(values[n] || '', options) + '</td>';
            }).join('') + '</tr>';
          }).join('') + '</tbody></table></div>');
        continue;
      }
      var heading = trimmed.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
      if (heading) { flush(); result.push('<h' + heading[1].length + '>' + inline(heading[2], options) + '</h' + heading[1].length + '>'); continue; }
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); result.push('<hr>'); continue; }
      var item = line.match(/^\s*(?:([-+*])|\d+[.)])\s+(.+)$/);
      if (item) {
        flushParagraph(); var kind = item[1] ? 'ul' : 'ol';
        if (listKind && listKind !== kind) flushList();
        listKind = kind; list.push(item[2]); continue;
      }
      var quote = trimmed.match(/^>\s?(.*)$/);
      if (quote) { flush(); result.push('<blockquote>' + inline(quote[1], options) + '</blockquote>'); continue; }
      flushList(); paragraph.push(trimmed);
    }
    flush(); return result.join('');
  }

  global.OrgXMarkdown = { render: render, inline: inline, safeHref: safeHref };
})(typeof window !== 'undefined' ? window : globalThis);
