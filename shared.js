/* Shared by the extension, preparation capture, and synthetic tests. No dependencies. */
var LessonOverlay = (() => {
  const VERSION = 1;
  const lessonPath = /^\/lessons\/(s\d{2}e\d{2})\/?$/;
  const tokenPattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  function tokens(text) {
    return [...text.matchAll(tokenPattern)].map((m) => ({
      key: m[0].normalize('NFKC').toLowerCase().replaceAll('’', "'"),
      start: m.index,
      end: m.index + m[0].length,
    }));
  }
  const normalize = (text) =>
    tokens(text)
      .map((t) => t.key)
      .join(' ');
  async function hash(text) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  function lessonId(url) {
    try {
      const u = new URL(url);
      return u.origin === 'https://hq.mega.dev' ? (lessonPath.exec(u.pathname)?.[1] ?? null) : null;
    } catch {
      return null;
    }
  }
  function mediaPath(url, base = 'https://hq.mega.dev') {
    const u = new URL(url, base);
    if (u.origin !== 'https://hq.mega.dev') throw Error('Unsupported media origin');
    return u.pathname;
  }
  function textParts(element) {
    const result = [];
    const walker = element.ownerDocument.createTreeWalker(element, 4);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement.closest('.example-local,script,style,noscript,.mega-overlay-controls'))
        continue;
      if (element.tagName === 'LI' && node.parentElement.closest('li') !== element) continue;
      result.push(node);
    }
    return result;
  }
  function snapshot(doc) {
    const article = doc.querySelector('.lesson-article .prose');
    if (!article) throw Error('Lesson article not found');
    let section = '';
    const targets = [];
    for (const element of article.querySelectorAll('p,li,h2,h3,h4')) {
      if (
        element.closest(
          '.lesson-audio,.lesson-audio-scroll,.lesson-audio-controls,.mega-overlay-controls,noscript',
        )
      )
        continue;
      if (element.tagName === 'P' && element.closest('li')) continue;
      const figure = element.querySelector('a.figure-zoom');
      const parts = textParts(element);
      const text = parts.map((n) => n.textContent).join('');
      const normalized = normalize(text);
      const kind = figure
        ? 'figure'
        : /^H/.test(element.tagName)
          ? 'heading'
          : element.tagName === 'LI'
            ? 'item'
            : 'paragraph';
      if (
        !figure &&
        (!normalized || /^https?:\/\/\S+$/.test(text.trim()) || text.trim() === 'Open figure')
      )
        continue;
      if (kind === 'heading') section = element.id || normalized;
      const identity = figure ? mediaPath(figure.getAttribute('href')) : normalized;
      targets.push({
        kind,
        section,
        identity,
        text,
        alt: figure?.querySelector('img')?.alt || '',
        element,
        parts,
      });
    }
    if (!targets.length || targets.length > 5000) throw Error('Unsupported article size');
    return targets;
  }
  async function identify(targets) {
    const seen = new Map();
    return Promise.all(
      targets.map(async (t) => {
        const signature = JSON.stringify([t.kind, t.section, t.identity]);
        const occurrence = seen.get(signature) || 0;
        seen.set(signature, occurrence + 1);
        return {
          ...t,
          key: await hash(JSON.stringify([t.kind, t.section, t.identity, occurrence])),
        };
      }),
    );
  }
  const fingerprint = (targets) => hash(targets.map((t) => t.key).join('\n'));
  function validate(data, id) {
    const fail = () => {
      throw Error('Invalid or incompatible timing file');
    };
    const digest = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
    if (
      !/^s\d{2}e\d{2}$/.test(id) ||
      !data ||
      data.schema !== VERSION ||
      data.normalization !== VERSION ||
      data.lesson !== id ||
      !digest(data.article) ||
      !data.media ||
      !digest(data.media.sha256) ||
      typeof data.media.path !== 'string' ||
      !data.media.path.startsWith(`/lessons/${id}/audio/`) ||
      /[?#\\]/.test(data.media.path) ||
      data.media.path.includes('..') ||
      !Number.isFinite(data.media.duration) ||
      data.media.duration <= 0 ||
      data.media.duration > 86400 ||
      !['ready', 'partial'].includes(data.status) ||
      typeof data.revision !== 'string' ||
      data.revision.length > 80 ||
      !Array.isArray(data.targets) ||
      !data.targets.length ||
      data.targets.length > 5000 ||
      !Array.isArray(data.cues) ||
      !data.cues.length ||
      data.cues.length > 50000 ||
      !Array.isArray(data.unknown) ||
      data.unknown.length > 50001
    )
      fail();
    const keys = new Map();
    for (const t of data.targets) {
      if (
        !digest(t.key) ||
        keys.has(t.key) ||
        !Number.isInteger(t.tokens) ||
        t.tokens < 0 ||
        t.tokens > 100000 ||
        !['paragraph', 'item', 'heading', 'figure'].includes(t.kind)
      )
        fail();
      keys.set(t.key, t);
    }
    let end = 0;
    for (const c of data.cues) {
      const t = keys.get(c.target);
      if (
        !t ||
        !Number.isFinite(c.start) ||
        !Number.isFinite(c.end) ||
        c.start < end ||
        c.start < 0 ||
        c.end <= c.start ||
        c.end > data.media.duration ||
        !Number.isInteger(c.from) ||
        !Number.isInteger(c.to) ||
        c.from < 0 ||
        c.to < c.from ||
        c.to > t.tokens
      )
        fail();
      end = c.end;
    }
    // Unknown ranges must be exactly the complement: no hidden gaps or overlaps.
    const unknown = gaps(data.cues, data.media.duration);
    if (JSON.stringify(unknown) !== JSON.stringify(data.unknown)) fail();
    return data;
  }
  function gaps(cues, duration) {
    const result = [];
    let end = 0;
    for (const c of cues) {
      if (c.start > end) result.push([end, c.start]);
      end = c.end;
    }
    if (end < duration) result.push([end, duration]);
    return result;
  }
  function cueAt(cues, time) {
    let lo = 0,
      hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cues[mid].start <= time) lo = mid + 1;
      else hi = mid;
    }
    const c = cues[lo - 1];
    return c && time < c.end ? c : null;
  }
  function scrollTop(rect, height, y, tall = false) {
    if (rect.top >= 60 && rect.top <= height * 0.72 && (tall || rect.bottom <= height * 0.85))
      return null;
    return Math.max(0, y + rect.top - Math.min(120, height * 0.2));
  }
  return {
    VERSION,
    tokens,
    normalize,
    hash,
    lessonId,
    mediaPath,
    textParts,
    snapshot,
    identify,
    fingerprint,
    validate,
    gaps,
    cueAt,
    scrollTop,
  };
})();
if (typeof module !== 'undefined') module.exports = LessonOverlay;
