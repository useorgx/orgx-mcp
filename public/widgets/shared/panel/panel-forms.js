/**
 * OrgX panel forms: a decision that asks several questions, one at a time,
 * and a decision that reviews several outputs, each kept or sent back with
 * its own note.
 *
 * Pure string builders and draft readers; the controller owns state and
 * events. State per decision:
 *   form   { step, values: { [fieldId]: string | boolean | string[] } }
 *   review { verdicts: { [itemId]: 'keep' | 'send_back' }, notes: { [itemId]: string } }
 * Every control uses data-action so the controller's one click handler
 * routes it.
 */
(function attachPanelForms(global) {
  'use strict';
  if (global.OrgXPanelForms) return;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clip(text, max) {
    var chars = Array.from(String(text || ''));
    return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('').trimEnd() + '…';
  }

  // ── Questions ─────────────────────────────────────────────────

  /** The contract's fields, read defensively. */
  function fieldsOf(raw) {
    var list = raw && Array.isArray(raw.fields) ? raw.fields : [];
    return list.filter(function valid(f) { return f && f.id && f.label && f.type; }).map(function read(f) {
      var options = Array.isArray(f.options) ? f.options.filter(function ok(o) { return o && o.id && o.label; }) : [];
      var multi = f.type === 'multi_select';
      var max = multi ? Math.max(1, Math.min(options.length, Number(f.max_select) || options.length)) : 1;
      return {
        id: String(f.id), type: f.type, label: String(f.label), stepTitle: f.step_title || '',
        description: f.description || '', placeholder: f.placeholder || '', required: f.required === true,
        options: options.map(function opt(o) { return { id: String(o.id), label: String(o.label), description: o.description || '', recommended: o.recommended === true }; }),
        min: multi ? Math.min(max, Math.max(0, Number(f.min_select) || 0)) : 0, max: max,
        maxLength: Math.min(2000, Number(f.max_length) || 2000),
        range: f.type === 'number' ? numberRange(f.number) : null,
        suggestions: (f.type === 'text' || f.type === 'textarea') && Array.isArray(f.suggestions)
          ? f.suggestions.filter(function s(x) { return typeof x === 'string' && x.trim(); }).map(function t(x) { return x.trim(); }).slice(0, 6) : [],
      };
    }).filter(function askable(f) { return f.type !== 'number' || f.range; });
  }

  /** A number field's slider: only with a real range from the asker; never a guessed one. */
  function numberRange(raw) {
    if (!raw || typeof raw.min !== 'number' || typeof raw.max !== 'number' || !(raw.max > raw.min)) return null;
    var step = typeof raw.step === 'number' && raw.step > 0 ? raw.step : 1;
    var rec = typeof raw.recommended === 'number' && raw.recommended >= raw.min && raw.recommended <= raw.max ? raw.recommended : null;
    return { min: raw.min, max: raw.max, step: step, unit: raw.unit || '', recommended: rec };
  }
  function numberText(f, value) {
    var n = Number(value);
    if (!isFinite(n)) return '';
    var u = f.range && f.range.unit ? f.range.unit : '';
    var shown = n.toLocaleString();
    return u === '$' ? '$' + shown : u ? shown + ' ' + u : shown;
  }
  /** One step up or down, kept on the field's grid and inside its range. */
  function stepNumber(f, value, delta) {
    var r = f.range;
    var n = Number(value);
    if (!isFinite(n)) n = r.recommended !== null ? r.recommended : r.min;
    n = Math.min(r.max, Math.max(r.min, n + delta * r.step));
    var digits = (String(r.step).split('.')[1] || '').length;
    return String(Number(n.toFixed(digits)));
  }

  /** A fresh form: recommended choices pre-filled, nothing sent until the person confirms. */
  function newForm(fields) {
    var values = {};
    fields.forEach(function seed(f) {
      var picks = f.options.filter(function rec(o) { return o.recommended; }).map(function id(o) { return o.id; });
      if (f.type === 'single_select' && picks.length) values[f.id] = picks[0];
      if (f.type === 'multi_select' && picks.length) values[f.id] = picks.slice(0, f.max);
      // The asker's recommended amount starts set; moving it is the answer.
      if (f.type === 'number' && f.range && f.range.recommended !== null) values[f.id] = String(f.range.recommended);
    });
    return { step: 0, values: values, touched: false };
  }

  function answered(f, value) {
    if (f.type === 'boolean') return value === true || value === false;
    if (f.type === 'multi_select') return Array.isArray(value) && value.length >= Math.max(1, f.min);
    if (f.type === 'number') return typeof value === 'string' && value.trim() !== '' && isFinite(Number(value));
    return typeof value === 'string' && value.trim().length > 0;
  }

  /** What the field's answer reads as on the review step. */
  function answerText(f, value) {
    if (!answered(f, value)) return '';
    if (f.type === 'boolean') return value ? 'Yes' : 'No';
    if (f.type === 'number') return numberText(f, value);
    if (f.type === 'single_select' || f.type === 'multi_select') {
      var ids = Array.isArray(value) ? value : [value];
      return f.options.filter(function on(o) { return ids.indexOf(o.id) !== -1; }).map(function label(o) { return o.label; }).join(', ');
    }
    return String(value).trim();
  }

  /** The args widget_decide takes, and what still blocks sending. */
  function formDraft(fields, form) {
    var answers = {};
    var missing = [];
    fields.forEach(function collect(f) {
      var value = form.values[f.id];
      if (answered(f, value)) {
        answers[f.id] = f.type === 'number' ? String(Number(value)) : typeof value === 'string' ? value.trim().slice(0, f.maxLength) : Array.isArray(value) ? value.slice() : value;
      } else if (f.required) {
        missing.push(f.id);
      }
    });
    return { answers: answers, missing: missing, onReview: form.step >= fields.length };
  }

  /** The footer's primary while stepping: Next, Skip, Review answers, then the decision's own label. */
  function formPrimary(fields, form, sendLabel) {
    if (form.step >= fields.length) {
      var draft = formDraft(fields, form);
      return { label: sendLabel, disabled: draft.missing.length > 0, advance: false, heading: draft.missing.length ? 'Some answers are missing' : 'Ready to send', detail: draft.missing.length ? 'answer the required questions first' : 'recorded in OrgX' };
    }
    var f = fields[form.step];
    var ok = answered(f, form.values[f.id]);
    var last = form.step === fields.length - 1;
    var label = ok || !f.required ? (last ? 'Review answers' : ok ? 'Next' : 'Skip') : last ? 'Review answers' : 'Next';
    var done = fields.filter(function has(x) { return answered(x, form.values[x.id]); }).length;
    return {
      label: label, disabled: !ok && f.required, advance: true,
      heading: done + ' of ' + fields.length + ' answered',
      detail: !ok && f.required ? 'answer to continue' : ok ? 'nothing is sent yet' : 'optional',
    };
  }

  function stepperHtml(id, fields, form) {
    var total = fields.length + 1;
    var segs = '';
    for (var k = 0; k < total; k += 1) {
      var state = k < form.step ? 'done' : k === form.step ? 'now' : 'next';
      segs += '<span class="fq-seg" data-state="' + state + '"></span>';
    }
    var onReview = form.step >= fields.length;
    var where = onReview ? 'Review' : 'Question ' + (form.step + 1) + ' of ' + fields.length;
    return '<div class="fq-head"><div class="fq-segs" aria-hidden="true">' + segs + '</div>' +
      '<div class="fq-where"><span>' + esc(where) + '</span>' +
      (form.step > 0 ? '<button type="button" class="text-btn fq-back" data-action="q-back" data-id="' + esc(id) + '">Back</button>' : '') + '</div></div>';
  }

  function choiceHtml(id, f, o, on, tag, toggle) {
    return '<button type="button" class="opt" data-action="q-pick" data-id="' + esc(id) + '" data-field="' + esc(f.id) + '" data-value="' + esc(o.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      (toggle ? '<span class="opt-box" aria-hidden="true">✓</span>' : '') +
      '<span class="opt-text">' + esc(o.label) + (o.description ? '<span class="opt-desc">' + esc(o.description) + '</span>' : '') + '</span>' +
      (tag ? '<span class="opt-tag rec">' + esc(tag) + '</span>' : '') + '</button>';
  }

  function fieldHtml(id, f, form, limitHit) {
    var value = form.values[f.id];
    var labelId = 'fq-' + esc(id) + '-' + esc(f.id);
    var head = (f.stepTitle ? '<p class="fq-kicker">' + esc(f.stepTitle) + '</p>' : '') +
      '<p class="fq-label" id="' + labelId + '">' + esc(f.label) + (f.required ? '' : ' <span class="fq-opt">optional</span>') + '</p>' +
      (f.description ? '<p class="fq-desc">' + esc(f.description) + '</p>' : '');
    var control = '';
    if (f.type === 'single_select' || f.type === 'multi_select') {
      var multi = f.type === 'multi_select';
      var picked = multi ? (Array.isArray(value) ? value : []) : value ? [value] : [];
      control = '<div class="opts" role="group" aria-labelledby="' + labelId + '">' +
        (multi ? '<p class="opts-label">' + esc(f.min > 1 ? 'Choose ' + f.min + '–' + f.max : 'Choose up to ' + f.max) + '</p>' : '') +
        f.options.map(function opt(o) { return choiceHtml(id, f, o, picked.indexOf(o.id) !== -1, o.recommended ? 'Recommended' : '', multi); }).join('') +
        (multi && limitHit ? '<p class="opts-limit" role="status">You can pick ' + f.max + '. Uncheck one to add “' + esc(clip(limitHit, 40)) + '”.</p>' : '') + '</div>';
    } else if (f.type === 'number') {
      var r = f.range;
      var cur = answered(f, value) ? Number(value) : r.recommended !== null ? r.recommended : r.min;
      var isRec = r.recommended !== null && cur === r.recommended;
      control = '<div class="fq-amt" data-amt="' + esc(f.id) + '">' +
        '<p class="fq-amt-v"><output id="' + labelId + '-v" data-amt-out="' + esc(f.id) + '">' + esc(numberText(f, cur)) + '</output>' +
        (r.recommended !== null ? '<span class="opt-tag rec" data-amt-rec' + (isRec ? '' : ' hidden') + '>Recommended</span>' : '') + '</p>' +
        '<div class="fq-amt-row"><button type="button" class="fq-amt-b" data-action="q-step" data-id="' + esc(id) + '" data-field="' + esc(f.id) + '" data-delta="-1" aria-label="Less">−</button>' +
        '<input type="range" class="fq-amt-r" data-qnum="' + esc(f.id) + '" data-id="' + esc(id) + '" min="' + r.min + '" max="' + r.max + '" step="' + r.step + '" value="' + cur + '" aria-labelledby="' + labelId + '" aria-valuetext="' + esc(numberText(f, cur)) + '">' +
        '<button type="button" class="fq-amt-b" data-action="q-step" data-id="' + esc(id) + '" data-field="' + esc(f.id) + '" data-delta="1" aria-label="More">+</button></div>' +
        '<p class="fq-amt-scale" aria-hidden="true"><span>' + esc(numberText(f, r.min)) + '</span>' + (r.recommended !== null ? '<span>Recommended ' + esc(numberText(f, r.recommended)) + '</span>' : '') + '<span>' + esc(numberText(f, r.max)) + '</span></p></div>';
    } else if (f.type === 'boolean') {
      control = '<div class="opts fq-yn" role="group" aria-labelledby="' + labelId + '">' +
        choiceHtml(id, f, { id: 'true', label: 'Yes' }, value === true, '', false) +
        choiceHtml(id, f, { id: 'false', label: 'No' }, value === false, '', false) + '</div>';
    } else {
      control = '<textarea class="fq-text" data-qfield="' + esc(f.id) + '" data-id="' + esc(id) + '" aria-labelledby="' + labelId + '" maxlength="' + f.maxLength + '"' +
        (f.type === 'text' ? ' rows="1"' : ' rows="3"') + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '>' + esc(typeof value === 'string' ? value : '') + '</textarea>' +
        (f.type === 'text' ? '<p class="fq-hint">Enter to continue</p>' : '') +
        // The asker's ready answers: a tap fills the box to edit; nothing is sent until the person confirms.
        (f.suggestions.length ? '<div class="sugg" role="group" aria-label="Suggested answers"><span class="sugg-l">Suggested</span>' + f.suggestions.map(function chip(x) {
          return '<button type="button" class="pn-chip sugg-c" data-action="q-suggest" data-id="' + esc(id) + '" data-field="' + esc(f.id) + '" data-value="' + esc(x) + '" aria-pressed="' + (typeof value === 'string' && value.trim() === x) + '">' + esc(x) + '</button>';
        }).join('') + '</div>' : '');
    }
    return head + control;
  }

  function reviewHtml(id, fields, form) {
    return '<p class="fq-label">Check your answers</p><dl class="fq-review">' + fields.map(function row(f, k) {
      var text = answerText(f, form.values[f.id]);
      return '<div class="fq-row"><dt>' + esc(f.label) + '</dt><dd' + (text ? '' : ' class="none"') + '>' +
        esc(text || (f.required ? 'Not answered · required' : 'Skipped')) + '</dd>' +
        '<button type="button" class="text-btn" data-action="q-goto" data-id="' + esc(id) + '" data-step="' + k + '">Change<span class="sr-only"> ' + esc(f.label) + '</span></button></div>';
    }).join('') + '</dl>';
  }

  /** The whole stepper: progress, then one question or the review. */
  function questionsHtml(id, fields, form, opts) {
    var onReview = form.step >= fields.length;
    var dir = opts && opts.dir ? ' data-dir="' + esc(opts.dir) + '"' : '';
    return '<section class="fq" data-form="' + esc(id) + '" aria-label="Questions">' + stepperHtml(id, fields, form) +
      '<div class="fq-body" data-step="' + form.step + '"' + dir + '>' +
      (onReview ? reviewHtml(id, fields, form) : fieldHtml(id, fields[form.step], form, opts && opts.limitHit)) + '</div></section>';
  }

  /**
   * One pick on the current question. Returns what changed: 'advance' when a
   * single answer should move on, 'limit' when a multi pick is full.
   */
  function pick(fields, form, fieldId, value) {
    var f = fields.filter(function byId(x) { return x.id === fieldId; })[0];
    if (!f) return null;
    form.touched = true;
    if (f.type === 'boolean') { form.values[f.id] = value === 'true'; return 'advance'; }
    if (f.type === 'single_select') { form.values[f.id] = value; return 'advance'; }
    if (f.type === 'multi_select') {
      var current = Array.isArray(form.values[f.id]) ? form.values[f.id] : [];
      if (current.indexOf(value) !== -1) { form.values[f.id] = current.filter(function keep(v) { return v !== value; }); return 'changed'; }
      if (current.length >= f.max) return 'limit';
      var next = current.concat(value);
      form.values[f.id] = f.options.map(function ids(o) { return o.id; }).filter(function on(oid) { return next.indexOf(oid) !== -1; });
      return 'changed';
    }
    return null;
  }

  // ── Item-by-item review ───────────────────────────────────────

  function itemsOf(raw) {
    var list = raw && Array.isArray(raw.items) ? raw.items : [];
    return list.filter(function valid(it) { return it && it.id && it.label; }).map(function read(it) {
      return { id: String(it.id), label: String(it.label), description: it.description || '', url: it.url || '', type: it.type || '', flagged: it.flagged === true, flagNote: it.flag_note || '' };
    });
  }

  /** Flagged items start sent back with the flag as their note; the rest start kept. */
  function newReview(items) {
    var verdicts = {};
    var notes = {};
    items.forEach(function seed(it) {
      verdicts[it.id] = it.flagged ? 'send_back' : 'keep';
      if (it.flagged && it.flagNote) notes[it.id] = it.flagNote;
    });
    return { verdicts: verdicts, notes: notes, touched: false };
  }

  function missingNotes(items, review) {
    return items.filter(function needs(it) { return review.verdicts[it.id] === 'send_back' && !String(review.notes[it.id] || '').trim(); });
  }

  function reviewDraft(items, review) {
    var kept = items.filter(function keep(it) { return review.verdicts[it.id] !== 'send_back'; });
    var back = items.length - kept.length;
    var missing = missingNotes(items, review);
    return {
      action: kept.length ? 'approve' : 'reject',
      itemReviews: items.map(function verdict(it) {
        var out = { id: it.id, verdict: review.verdicts[it.id] === 'send_back' ? 'send_back' : 'keep' };
        var note = String(review.notes[it.id] || '').trim();
        if (out.verdict === 'send_back' && note) out.note = note.slice(0, 2000);
        return out;
      }),
      kept: kept.length, back: back, missing: missing,
    };
  }

  /** The primary names the outcome; with notes missing it says how many and jumps to the first. */
  function reviewPrimary(items, review) {
    var d = reviewDraft(items, review);
    var label = d.missing.length
      ? 'Add ' + d.missing.length + (d.missing.length === 1 ? ' note' : ' notes') + ' to continue'
      : !d.back ? 'Keep all ' + items.length : !d.kept ? 'Send all ' + items.length + ' back' : 'Keep ' + d.kept + ' · send back ' + d.back;
    return {
      label: label, action: d.action, jump: d.missing.length > 0,
      heading: d.back ? d.kept + ' kept, ' + d.back + ' going back' : 'Keeping all ' + items.length,
      detail: d.missing.length ? 'each one going back needs a note' : 'recorded in OrgX',
    };
  }

  function itemsHtml(id, items, review) {
    var missing = missingNotes(items, review);
    var back = items.filter(function sent(it) { return review.verdicts[it.id] === 'send_back'; });
    var withNote = back.filter(function has(it) { return String(review.notes[it.id] || '').trim(); });
    var copy = withNote.length && missing.length
      ? '<button type="button" class="text-btn fi-copy" data-action="item-copy-note" data-id="' + esc(id) + '">Use the first note for the ' + missing.length + ' without one</button>'
      : '';
    return '<section class="fi" data-review="' + esc(id) + '" aria-label="Review each one"><p class="opts-label">Keep or send back each one</p><ul class="fi-list">' +
      items.map(function row(it, k) {
        var sent = review.verdicts[it.id] === 'send_back';
        var noteId = 'fi-note-' + esc(id) + '-' + k;
        return '<li class="fi-item' + (sent ? ' sent' : '') + '" data-item="' + esc(it.id) + '">' +
          '<div class="fi-main"><p class="fi-label">' + (it.type && global.OrgXPanelIcons ? global.OrgXPanelIcons.output(it.type, 14) : '') + esc(it.label) +
          (it.flagged ? ' <span class="fi-flag" title="' + esc(it.flagNote) + '">Flagged</span>' : '') + '</p>' +
          (it.description ? '<p class="fi-desc">' + esc(it.description) + '</p>' : '') +
          (it.url ? '<button type="button" class="text-btn fi-open" data-action="open" data-url="' + esc(it.url) + '">Open <span aria-hidden="true">↗</span><span class="sr-only"> ' + esc(it.label) + ' (opens OrgX)</span></button>' : '') + '</div>' +
          '<div class="fi-toggle" role="group" aria-label="' + esc(it.label) + '">' +
          '<button type="button" class="fi-v" data-action="item-verdict" data-id="' + esc(id) + '" data-item="' + esc(it.id) + '" data-verdict="keep" aria-pressed="' + (!sent) + '">Keep</button>' +
          '<button type="button" class="fi-v" data-action="item-verdict" data-id="' + esc(id) + '" data-item="' + esc(it.id) + '" data-verdict="send_back" aria-pressed="' + sent + '">Send back</button></div>' +
          (sent ? '<div class="fi-note"><label for="' + noteId + '">What should change in ' + esc(clip(it.label, 48)) + '? · required</label>' +
            '<textarea id="' + noteId + '" data-item-note="' + esc(it.id) + '" data-id="' + esc(id) + '" maxlength="2000" rows="2" placeholder="One line the agent can act on.">' + esc(review.notes[it.id] || '') + '</textarea></div>' : '') +
          '</li>';
      }).join('') + '</ul>' + copy + '</section>';
  }

  /** Fill only the empty notes with the first written one. */
  function copyNote(items, review) {
    var first = items.filter(function sent(it) { return review.verdicts[it.id] === 'send_back' && String(review.notes[it.id] || '').trim(); })[0];
    if (!first) return 0;
    var filled = 0;
    missingNotes(items, review).forEach(function fill(it) { review.notes[it.id] = review.notes[first.id]; filled += 1; });
    return filled;
  }

  global.OrgXPanelForms = {
    fieldsOf: fieldsOf, newForm: newForm, formDraft: formDraft, formPrimary: formPrimary, questionsHtml: questionsHtml,
    pick: pick, answered: answered, answerText: answerText, stepNumber: stepNumber, numberText: numberText,
    itemsOf: itemsOf, newReview: newReview, reviewDraft: reviewDraft, reviewPrimary: reviewPrimary, itemsHtml: itemsHtml,
    missingNotes: missingNotes, copyNote: copyNote,
  };
})(typeof window !== 'undefined' ? window : globalThis);
