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
