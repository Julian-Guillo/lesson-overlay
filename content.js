(() => {
  'use strict';

  const shared = LessonOverlay;
  const DEFAULT_COLOR = '#2d969b';
  const MEDIA_EVENTS = [
    'play',
    'timeupdate',
    'seeked',
    'pause',
    'ended',
    'loadedmetadata',
    'durationchange',
    'emptied',
    'ratechange',
  ];
  const SCROLL_KEYS = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '];

  let current = null;
  let discoveryPending = false;

  function clearHighlight(state) {
    state.highlight?.classList.remove('mega-overlay-active');
    state.highlight = null;
  }

  function detach() {
    if (!current) return;
    current.abort.abort();
    clearHighlight(current);
    current.article.style.removeProperty('--mega-overlay-rgb');
    current.ui.remove();
    current = null;
  }

  function createColorControls(article, signal) {
    const controls = document.createElement('div');
    controls.className = 'mega-overlay-color-controls';
    const label = document.createElement('label');
    label.textContent = 'Highlight ';
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.setAttribute('aria-label', 'Highlight color');
    picker.disabled = true;
    label.append(picker);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset color';
    reset.disabled = true;
    const notice = document.createElement('small');
    notice.setAttribute('role', 'status');
    const row = document.createElement('div');
    row.append(label, reset);
    controls.append(row, notice);

    function applyColor(value) {
      const color =
        typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)
          ? value.toLowerCase()
          : DEFAULT_COLOR;
      picker.value = color;
      const rgb = color
        .slice(1)
        .match(/../g)
        .map((channel) => parseInt(channel, 16));
      article.style.setProperty('--mega-overlay-rgb', rgb.join(', '));
      reset.disabled = color === DEFAULT_COLOR;
    }

    // Preview each input immediately; serialize committed writes so the last choice wins.
    let saveQueue = Promise.resolve();
    function saveColor() {
      const color = picker.value;
      saveQueue = saveQueue.then(async () => {
        try {
          await chrome.storage.local.set({ highlightColor: color });
          if (!signal.aborted && picker.value === color) notice.textContent = '';
        } catch {
          if (!signal.aborted && picker.value === color) {
            notice.textContent = 'Color changed for this page, but could not be saved.';
          }
        }
      });
    }

    picker.addEventListener('input', () => applyColor(picker.value), { signal });
    picker.addEventListener('change', saveColor, { signal });
    reset.addEventListener(
      'click',
      () => {
        applyColor(DEFAULT_COLOR);
        saveColor();
      },
      { signal },
    );

    applyColor(DEFAULT_COLOR);
    chrome.storage.local
      .get('highlightColor')
      .then((preferences) => {
        if (!signal.aborted) applyColor(preferences.highlightColor);
      })
      .catch(() => {
        if (!signal.aborted)
          notice.textContent = 'Could not load the saved color. Using the default.';
      })
      .finally(() => {
        if (!signal.aborted) picker.disabled = false;
      });
    return controls;
  }

  function createControls(article, signal) {
    const ui = document.createElement('aside');
    ui.className = 'mega-overlay-controls';
    ui.setAttribute('aria-label', 'Lesson audio follow');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'follow';
    button.textContent = 'Follow audio';
    button.disabled = true;
    const status = document.createElement('small');
    status.textContent = 'Loading local timings…';
    ui.append(button, createColorControls(article, signal), status);
    document.body.append(ui);
    return { ui, button, status };
  }

  function sentenceRect(target, cue) {
    const text = target.parts.map((node) => node.textContent).join('');
    const words = shared.tokens(text);
    if (!words[cue.from] || !words[cue.to - 1]) return target.element.getBoundingClientRect();
    const start = words[cue.from].start;
    const end = words[cue.to - 1].end;
    const range = document.createRange();
    let offset = 0;
    for (const part of target.parts) {
      const next = offset + part.textContent.length;
      if (start >= offset && start < next) range.setStart(part, start - offset);
      if (end > offset && end <= next) {
        range.setEnd(part, end - offset);
        break;
      }
      offset = next;
    }
    return range.getBoundingClientRect();
  }

  function followAudio(state, data, targets) {
    const { audio, button, status } = state;
    const signal = state.abort.signal;
    const resolved = new Map(targets.map((target) => [target.key, target]));
    const coverage =
      data.status === 'partial'
        ? 'Partial coverage; gaps stay unhighlighted.'
        : 'Ready; some narration may have no cue.';
    const detail = `${chrome.runtime.getManifest().version} · ${data.revision} · ${coverage}`;

    function checkMedia() {
      const path = shared.mediaPath(audio.currentSrc || audio.src);
      const changedDuration =
        Number.isFinite(audio.duration) && Math.abs(audio.duration - data.media.duration) > 1;
      if (path !== data.media.path || changedDuration) {
        throw Error('The lesson audio has changed. Prepare fresh timings.');
      }
    }

    function drawButton() {
      if (!state.enabled) button.textContent = 'Enable audio follow';
      else if (state.suspended) button.textContent = 'Resume following';
      else button.textContent = 'Following audio · On';
      button.setAttribute('aria-pressed', String(state.enabled && !state.suspended));
      status.textContent = state.suspended ? 'Scrolling paused. Highlighting continues.' : detail;
    }

    function update() {
      try {
        checkMedia();
      } catch (error) {
        state.valid = false;
        clearHighlight(state);
        button.disabled = true;
        status.textContent = error.message;
        return;
      }
      if (!state.valid || !state.enabled || audio.ended) {
        clearHighlight(state);
        return;
      }
      const cue = shared.cueAt(data.cues, audio.currentTime);
      const target = cue ? resolved.get(cue.target) : null;
      if (state.highlight !== (target?.element ?? null)) {
        clearHighlight(state);
        if (target) {
          state.highlight = target.element;
          state.highlight.classList.add('mega-overlay-active');
        }
      }
      const recentlyScrolled = performance.now() - state.lastScroll < 850;
      if (!target || audio.paused || state.suspended || recentlyScrolled || document.hidden) return;
      const isFigure = target.kind === 'figure';
      const rect = isFigure ? target.element.getBoundingClientRect() : sentenceRect(target, cue);
      const top = shared.scrollTop(rect, innerHeight, scrollY, isFigure);
      if (top !== null && Math.abs(top - scrollY) > 2) {
        state.lastScroll = performance.now();
        const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top, behavior: reducedMotion ? 'instant' : 'smooth' });
      }
    }

    function suspend() {
      if (state.enabled && !audio.paused && !state.suspended) {
        state.suspended = true;
        drawButton();
      }
    }

    checkMedia();
    state.valid = true;
    button.disabled = false;
    drawButton();
    for (const event of MEDIA_EVENTS) audio.addEventListener(event, update, { signal });
    window.addEventListener('wheel', suspend, { passive: true, signal });
    window.addEventListener('touchmove', suspend, { passive: true, signal });
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (event.clientX >= document.documentElement.clientWidth) suspend();
      },
      { signal },
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.target.closest('input,textarea,select,button,[contenteditable="true"]')) return;
        if (SCROLL_KEYS.includes(event.key)) suspend();
      },
      { signal },
    );
    button.addEventListener(
      'click',
      () => {
        if (state.suspended || !state.enabled) {
          state.enabled = true;
          state.suspended = false;
        } else {
          state.enabled = false;
        }
        state.lastScroll = -Infinity;
        drawButton();
        update();
      },
      { signal },
    );
    update();
  }

  async function attach(audio, article, id) {
    detach();
    const abort = new AbortController();
    const controls = createControls(article, abort.signal);
    const state = {
      ...controls,
      abort,
      audio,
      article,
      id,
      highlight: null,
      enabled: true,
      suspended: false,
      valid: false,
      lastScroll: -Infinity,
    };
    current = state;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'lesson-timings', lesson: id });
      if (current !== state) return;
      if (!response?.ok) {
        throw Error(response?.error || 'Reload the extension and refresh this lesson.');
      }
      const data = shared.validate(response.data, id);
      const targets = await shared.identify(shared.snapshot(document));
      const articleHash = await shared.fingerprint(targets);
      if (current !== state) return;
      const changedTargets =
        targets.length !== data.targets.length ||
        targets.some(
          (target, i) =>
            target.key !== data.targets[i].key ||
            shared.tokens(target.text).length !== data.targets[i].tokens,
        );
      if (articleHash !== data.article || changedTargets) {
        throw Error('This article has changed. Prepare fresh timings for this lesson.');
      }
      followAudio(state, data, targets);
    } catch (error) {
      if (current === state) {
        state.button.textContent = 'Audio follow unavailable';
        state.status.textContent = error.message;
      }
    }
  }

  function discover() {
    discoveryPending = false;
    const id = shared.lessonId(location.href);
    const audio = document.querySelector('audio.lesson-audio-media');
    const article = document.querySelector('.lesson-article .prose');
    if (!id || !audio || !article) {
      detach();
      return;
    }
    if (current?.audio === audio && current?.article === article && current?.id === id) return;
    void attach(audio, article, id);
  }

  // Own highlight/class/style changes do not trigger this observer.
  const observer = new MutationObserver((records) => {
    if (records.every((record) => record.target.closest?.('.mega-overlay-controls'))) return;
    if (current && records.some((record) => current.article.contains(record.target))) detach();
    if (!discoveryPending) {
      discoveryPending = true;
      queueMicrotask(discover);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener(
    'pagehide',
    () => {
      observer.disconnect();
      detach();
    },
    { once: true },
  );
  window.addEventListener('popstate', discover);
  discover();
})();
