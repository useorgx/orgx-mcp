(function (global) {
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function iconSvg(path) {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      path +
      '</svg>'
    );
  }

  var toneIcons = {
    success: iconSvg('<path d="M20 6 9 17l-5-5"></path>'),
    error: iconSvg(
      '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><path d="M12 16h.01"></path>'
    ),
    warning: iconSvg(
      '<path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>'
    ),
    info: iconSvg(
      '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>'
    ),
  };

  var toastRegion = null;

  function ensureToastRegion() {
    if (toastRegion && document.body.contains(toastRegion)) return toastRegion;
    toastRegion = document.createElement('div');
    toastRegion.className = 'ox-toast-region';
    toastRegion.setAttribute('role', 'region');
    toastRegion.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(toastRegion);
    return toastRegion;
  }

  function dismissToast(node) {
    if (!node || node.dataset.leaving === 'true') return;
    node.dataset.leaving = 'true';
    node.classList.add('is-leaving');
    window.setTimeout(function () {
      node.remove();
    }, 180);
  }

  function showToast(options) {
    var opts = options || {};
    var region = ensureToastRegion();
    var tone = opts.tone || opts.type || 'info';
    var title = opts.title || '';
    var message = opts.message || '';
    var duration = Number.isFinite(opts.duration) ? opts.duration : 3600;
    var icon = opts.icon || toneIcons[tone] || toneIcons.info;

    var node = document.createElement('div');
    node.className = 'ox-toast ox-toast--' + tone;
    node.style.setProperty('--ox-toast-duration', duration + 'ms');
    node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    node.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
    node.innerHTML =
      '<div class="ox-toast__icon">' +
      icon +
      '</div>' +
      '<div class="ox-toast__body">' +
      (title
        ? '<div class="ox-toast__title">' + escapeHtml(title) + '</div>'
        : '') +
      (message
        ? '<div class="ox-toast__message">' + escapeHtml(message) + '</div>'
        : '') +
      '</div>' +
      '<button type="button" class="ox-toast__close" aria-label="Dismiss notification">' +
      iconSvg('<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>') +
      '</button>' +
      '<div class="ox-toast__progress" aria-hidden="true"></div>';

    region.appendChild(node);

    var closeButton = node.querySelector('.ox-toast__close');
    if (closeButton) {
      closeButton.addEventListener('click', function () {
        dismissToast(node);
      });
    }

    if (duration > 0) {
      window.setTimeout(function () {
        dismissToast(node);
      }, duration);
    }

    return node;
  }

  function setLoading(button, options) {
    var opts = options || {};
    if (!button || button.dataset.oxLoading === 'true') return;

    if (!button.dataset.oxOriginalHtml) {
      button.dataset.oxOriginalHtml = button.innerHTML;
    }

    if (!button.dataset.oxOriginalDisabled) {
      button.dataset.oxOriginalDisabled = button.disabled ? 'true' : 'false';
    }

    var rect = button.getBoundingClientRect();
    if (rect.width) {
      button.style.width = Math.ceil(rect.width) + 'px';
    }

    var loadingLabel =
      opts.loadingLabel ||
      button.getAttribute('data-loading-label') ||
      button.textContent.trim() ||
      'Working';

    button.dataset.oxLoading = 'true';
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    button.innerHTML =
      '<span class="ox-action-btn__spinner" aria-hidden="true"></span>' +
      '<span class="ox-action-btn__label">' +
      escapeHtml(loadingLabel) +
      '</span>';
  }

  function clearLoading(button, options) {
    var opts = options || {};
    if (!button) return;

    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
    delete button.dataset.oxLoading;

    if (typeof opts.html === 'string') {
      button.innerHTML = opts.html;
    } else if (button.dataset.oxOriginalHtml) {
      button.innerHTML = button.dataset.oxOriginalHtml;
    }

    if (button.dataset.oxOriginalDisabled === 'true') {
      button.disabled = true;
    } else {
      button.disabled = false;
    }

    window.requestAnimationFrame(function () {
      button.style.removeProperty('width');
    });
  }

  function setDisabled(button, disabled) {
    if (!button) return;
    button.disabled = !!disabled;
    if (disabled) {
      button.setAttribute('aria-disabled', 'true');
    } else {
      button.removeAttribute('aria-disabled');
    }
  }

  global.OrgXWidgetUX = {
    toast: {
      show: showToast,
      success: function (title, message, duration) {
        return showToast({ tone: 'success', title: title, message: message, duration: duration });
      },
      error: function (title, message, duration) {
        return showToast({ tone: 'error', title: title, message: message, duration: duration });
      },
      warning: function (title, message, duration) {
        return showToast({ tone: 'warning', title: title, message: message, duration: duration });
      },
      info: function (title, message, duration) {
        return showToast({ tone: 'info', title: title, message: message, duration: duration });
      },
      dismiss: dismissToast,
    },
    setLoading: setLoading,
    clearLoading: clearLoading,
    setDisabled: setDisabled,
    escapeHtml: escapeHtml,
  };
})(window);

(function () {
  var LIVE_REGION_ID = 'orgx-widget-live-region';

  function toRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function fieldValueAsTrimmedString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function buildConfigAnswerKey(stepId) {
    return '__config:' + stepId;
  }

  function buildFallbackConfigRequirement(step) {
    if (!step) return null;
    var fields = toArray(step.fields);
    var provider =
      (step.config && step.config.provider) ||
      (
        fields.find(function (field) {
          return field && field.provider;
        }) || {}
      ).provider ||
      null;
    if (!provider) return null;

    return {
      id: step.id,
      provider: provider,
      label: step.title || 'Configuration',
      description: step.description || null,
      secureFields: fields
        .filter(function (field) {
          return field && field.type === 'secret';
        })
        .map(function (field) {
          return field.id;
        }),
      envVars:
        step.config && Array.isArray(step.config.envVars)
          ? step.config.envVars
          : [],
      status: (step.config && step.config.status) || 'idle',
      message: (step.config && step.config.message) || null,
      sessionId: (step.config && step.config.sessionId) || null,
      validatedAt: (step.config && step.config.validatedAt) || null,
    };
  }

  function ensureLiveRegion() {
    var existing = document.getElementById(LIVE_REGION_ID);
    if (existing) return existing;

    var region = document.createElement('div');
    region.id = LIVE_REGION_ID;
    region.setAttribute('data-orgx-live-region', 'true');
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    document.body.appendChild(region);
    return region;
  }

  function announce(message) {
    if (!message) return;
    var region = ensureLiveRegion();
    region.textContent = '';
    window.setTimeout(function () {
      region.textContent = String(message);
    }, 20);
  }

  function focusElement(selector, options) {
    if (!selector) return false;
    var node = document.querySelector(selector);
    if (!node || typeof node.focus !== 'function') return false;

    var previousTabIndex = node.getAttribute('tabindex');
    if (!node.hasAttribute('tabindex')) {
      node.setAttribute('tabindex', '-1');
    }

    node.focus({
      preventScroll: !(options && options.allowScroll),
    });

    if (!previousTabIndex) {
      window.setTimeout(function () {
        if (document.activeElement !== node) {
          node.removeAttribute('tabindex');
        }
      }, 0);
    }

    return true;
  }

  function afterRender(selector, options) {
    window.requestAnimationFrame(function () {
      focusElement(selector, options);
    });
  }

  function resolveVisibilityCandidate(condition, state) {
    if (!condition) return undefined;
    if (condition.optionId) return state.selectedOptionId;
    if (condition.fieldId) {
      return state.answers ? state.answers[condition.fieldId] : undefined;
    }
    if (condition.stepId) {
      if (!state.answers) return undefined;
      return (
        state.answers['__config:' + condition.stepId] ??
        state.answers['__step:' + condition.stepId]
      );
    }
    return undefined;
  }

  function evaluateVisibilityCondition(condition, state) {
    if (!condition) return true;

    if (
      condition.optionId &&
      condition.equals === undefined &&
      condition.includes === undefined
    ) {
      return state.selectedOptionId === condition.optionId;
    }

    var candidate = resolveVisibilityCandidate(condition, state);

    if (condition.truthy === true) return Boolean(candidate);
    if (condition.truthy === false) return !candidate;
    if (condition.includes) {
      return (
        Array.isArray(candidate) && candidate.indexOf(condition.includes) !== -1
      );
    }
    if (condition.equals !== undefined) return candidate === condition.equals;
    return Boolean(candidate);
  }

  function isNodeVisible(node, state) {
    var visibility =
      node && Array.isArray(node.visibility) ? node.visibility : [];
    if (!visibility.length) return true;
    for (var i = 0; i < visibility.length; i += 1) {
      if (!evaluateVisibilityCondition(visibility[i], state)) return false;
    }
    return true;
  }

  function filterVisibleInteraction(interaction, state) {
    if (!interaction || !Array.isArray(interaction.steps)) return null;
    return {
      kind: interaction.kind,
      version: interaction.version,
      draft: interaction.draft || null,
      outcome: interaction.outcome || null,
      isComplex: interaction.isComplex === true,
      hasQuestions: interaction.hasQuestions === true,
      hasConfigStep: interaction.hasConfigStep === true,
      requiresStructuredReview: interaction.requiresStructuredReview === true,
      steps: interaction.steps
        .filter(function (step) {
          return isNodeVisible(step, state);
        })
        .map(function (step) {
          return Object.assign({}, step, {
            options: toArray(step.options).filter(function (option) {
              return isNodeVisible(option, state);
            }),
            fields: toArray(step.fields).filter(function (field) {
              return isNodeVisible(field, state);
            }),
          });
        }),
    };
  }

  function getVisibleSteps(interaction, state) {
    var filtered = filterVisibleInteraction(interaction, state);
    return filtered && Array.isArray(filtered.steps) ? filtered.steps : [];
  }

  function getCurrentStep(interaction, currentStepId, state) {
    var steps = getVisibleSteps(interaction, state);
    if (!steps.length) return null;
    for (var i = 0; i < steps.length; i += 1) {
      if (steps[i].id === currentStepId) return steps[i];
    }
    return steps[0];
  }

  function getCurrentStepIndex(interaction, currentStepId, state) {
    var current = getCurrentStep(interaction, currentStepId, state);
    if (!current) return -1;
    var steps = getVisibleSteps(interaction, state);
    for (var i = 0; i < steps.length; i += 1) {
      if (steps[i].id === current.id) return i;
    }
    return -1;
  }

  function collectOptions(interaction, state) {
    var visible = getVisibleSteps(interaction, state);
    var options = {};
    for (var i = 0; i < visible.length; i += 1) {
      var stepOptions = toArray(visible[i].options);
      for (var j = 0; j < stepOptions.length; j += 1) {
        if (stepOptions[j] && stepOptions[j].id) {
          options[stepOptions[j].id] = stepOptions[j];
        }
      }
    }
    return options;
  }

  function resolveSelectedOption(interaction, selectedOptionId, state) {
    if (!selectedOptionId) return null;
    var options = collectOptions(interaction, state);
    return options[selectedOptionId] || null;
  }

  function isFieldSatisfied(field, context) {
    var answers = toRecord(context.answers);
    var selectedSurfaceIds = toArray(context.selectedSurfaceIds);
    var value = answers[field.id];

    if (field.type === 'boolean' || field.type === 'confirmation') {
      return value === true;
    }
    if (field.type === 'multi_select') {
      return Array.isArray(value) && value.length > 0;
    }
    if (field.type === 'surface_picker') {
      return selectedSurfaceIds.length > 0;
    }
    return fieldValueAsTrimmedString(value).length > 0;
  }

  function validateStep(params) {
    var step = params.step || null;
    if (!step || step.required === false) {
      return { valid: true, message: null };
    }

    var state = {
      selectedOptionId: params.selectedOptionId || null,
      answers: toRecord(params.answers),
    };
    var selectedOption = resolveSelectedOption(
      params.interaction || null,
      params.selectedOptionId || null,
      state
    );

    if (step.type === 'options') {
      return params.selectedOptionId
        ? { valid: true, message: null }
        : { valid: false, message: 'Choose an option to continue.' };
    }

    if (step.type === 'questions' || step.type === 'surfaces') {
      var fields = toArray(step.fields);
      for (var i = 0; i < fields.length; i += 1) {
        var field = fields[i];
        if (!field.required) continue;
        if (!isFieldSatisfied(field, params)) {
          return {
            valid: false,
            message:
              'Complete ' +
              String(field.label || 'this field').toLowerCase() +
              ' to continue.',
          };
        }
      }
      var hasSurfacePicker = step.type === 'surfaces';
      for (var j = 0; j < fields.length; j += 1) {
        if (fields[j].type === 'surface_picker') {
          hasSurfacePicker = true;
          break;
        }
      }
      if (
        toArray(params.availableSurfaces).length > 0 &&
        hasSurfacePicker &&
        toArray(params.selectedSurfaceIds).length === 0
      ) {
        return {
          valid: false,
          message: 'Select at least one surface to continue.',
        };
      }
      return { valid: true, message: null };
    }

    if (step.type === 'config') {
      var requirement =
        toRecord(params.configRequirements)[step.id] || step.config || null;
      if (requirement && requirement.status === 'configured') {
        return { valid: true, message: null };
      }
      return {
        valid: false,
        message:
          (requirement && requirement.message) ||
          'Configure this integration before continuing.',
      };
    }

    if (step.type === 'subrequests') {
      return (params.subrequestPendingCount || 0) === 0
        ? { valid: true, message: null }
        : {
            valid: false,
            message:
              'Finish the checklist items before submitting this decision.',
          };
    }

    if (step.type === 'confirm') {
      if (
        ((selectedOption && selectedOption.requiresNote) ||
          params.finalPrimaryStatus !== 'approved') &&
        fieldValueAsTrimmedString(params.note).length === 0
      ) {
        return {
          valid: false,
          message: 'Add a decision note before submitting.',
        };
      }
      return { valid: true, message: null };
    }

    return { valid: true, message: null };
  }

  window.OrgXInteractionKit = {
    toRecord: toRecord,
    toArray: toArray,
    fieldValueAsTrimmedString: fieldValueAsTrimmedString,
    buildConfigAnswerKey: buildConfigAnswerKey,
    buildFallbackConfigRequirement: buildFallbackConfigRequirement,
    ensureLiveRegion: ensureLiveRegion,
    announce: announce,
    focusElement: focusElement,
    afterRender: afterRender,
    evaluateVisibilityCondition: evaluateVisibilityCondition,
    isNodeVisible: isNodeVisible,
    filterVisibleInteraction: filterVisibleInteraction,
    getVisibleSteps: getVisibleSteps,
    getCurrentStep: getCurrentStep,
    getCurrentStepIndex: getCurrentStepIndex,
    collectOptions: collectOptions,
    resolveSelectedOption: resolveSelectedOption,
    isFieldSatisfied: isFieldSatisfied,
    validateStep: validateStep,
  };
})();
