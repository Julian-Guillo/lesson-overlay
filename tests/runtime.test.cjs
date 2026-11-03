const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('node:crypto');
const S = require('../shared.js');

const html = `<main><audio class="lesson-audio-media" src="/lessons/s00e00/audio/test.mp3"></audio>
<article class="lesson-article"><div class="prose">
<h2 id="intro">A heading</h2><p>First <strong>useful</strong> sentence. Another sentence.</p>
<ul><li>Parent <a class="example-local" href="http://localhost:1">Local</a><ul><li><p>Child item.</p></li></ul></li></ul>
<p><a class="figure-zoom" href="/figures/demo/frame.html"><img alt="diagram"><img alt="diagram"></a></p>
<p>Last sentence.</p></div></article></main>`;
function dom(markup = html, lesson = 's00e00') {
  const d = new JSDOM(markup, {
    url: `https://hq.mega.dev/lessons/${lesson}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  d.window.TextEncoder = TextEncoder;
  Object.defineProperty(d.window.crypto, 'subtle', { value: webcrypto.subtle });
  return d;
}
async function pack(document) {
  const lesson = S.lessonId(document.URL);
  const targets = await S.identify(S.snapshot(document));
  const cues = [
    { start: 1, end: 3, target: targets[1].key, from: 0, to: 3 },
    { start: 4, end: 6, target: targets[1].key, from: 3, to: 5 },
    { start: 7, end: 9, target: targets[4].key, from: 0, to: 0 },
    { start: 10, end: 12, target: targets[5].key, from: 0, to: 2 },
  ];
  return {
    schema: 1,
    normalization: 1,
    lesson,
    revision: 'synthetic',
    status: 'partial',
    article: await S.fingerprint(targets),
    media: {
      path: S.mediaPath(document.querySelector('audio').src),
      sha256: 'a'.repeat(64),
      duration: 15,
    },
    targets: targets.map((t) => ({ key: t.key, kind: t.kind, tokens: S.tokens(t.text).length })),
    cues,
    unknown: S.gaps(cues, 15),
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail('Asynchronous runtime did not reach the expected state');
}

function colorStorage(initial = {}) {
  const saved = { ...initial };
  return {
    get: async () => ({ ...saved }),
    set: async (changes) => Object.assign(saved, changes),
  };
}

async function startRuntime(window, data, storage = colorStorage()) {
  window.chrome = {
    runtime: {
      sendMessage: async () => ({ ok: true, data }),
      getManifest: () => ({ version: 'test' }),
    },
    storage: { local: storage },
  };
  window.eval(fs.readFileSync(require.resolve('../shared.js'), 'utf8'));
  window.eval(fs.readFileSync(require.resolve('../content.js'), 'utf8'));
  await waitFor(() => window.document.querySelector('[data-action="follow"]')?.disabled === false);
  await waitFor(() => window.document.querySelector('input[type="color"]')?.disabled === false);
}

test('shared DOM adapter excludes duplicate images, local links and nested-list text', async () => {
  const d = dom();
  try {
    const ts = await S.identify(S.snapshot(d.window.document));
    assert.deepEqual(
      ts.map((t) => t.kind),
      ['heading', 'paragraph', 'item', 'item', 'figure', 'paragraph'],
    );
    assert.equal(ts[2].identity, 'parent');
    assert.equal(ts[3].identity, 'child item');
    assert.equal(ts[1].identity, 'first useful sentence another sentence');
    assert.equal(ts[4].identity, '/figures/demo/frame.html');
    const data = await pack(d.window.document);
    assert.equal(S.validate(data, 's00e00'), data);
    assert.equal(S.normalize('It’s A.I.\u00a0system'), "it's a i system");
  } finally {
    d.window.close();
  }
});

test('repeated text has distinct identities; paragraph splits and edits change fingerprints', async () => {
  const a = dom(html.replace('Last sentence.', 'First useful sentence. Another sentence.'));
  const b = dom(html.replace('Another sentence.', '</p><p>Another sentence.'));
  try {
    const ats = await S.identify(S.snapshot(a.window.document)),
      bts = await S.identify(S.snapshot(b.window.document));
    assert.notEqual(ats[1].key, ats.at(-1).key);
    assert.notEqual(await S.fingerprint(ats), await S.fingerprint(bts));
  } finally {
    a.window.close();
    b.window.close();
  }
});

test('clock lookup handles gaps, exact endpoints, backwards seeks and rate-independent media time', () => {
  const cues = [
    { start: 1, end: 3 },
    { start: 5, end: 8 },
  ];
  for (const [time, index] of [
    [0, -1],
    [1, 0],
    [2.9, 0],
    [3, -1],
    [5, 1],
    [7.99, 1],
    [8, -1],
    [1.2, 0],
  ]) {
    assert.equal(S.cueAt(cues, time), index < 0 ? null : cues[index]);
  }
  assert.deepEqual(S.gaps(cues, 10), [
    [0, 1],
    [3, 5],
    [8, 10],
  ]);
});

test('schema rejects invalid sources, overlaps, nonfinite times, bad offsets and concealed gaps', async () => {
  const d = dom();
  try {
    const valid = await pack(d.window.document);
    for (const mutate of [
      (x) => (x.schema = 2),
      (x) => (x.lesson = '../secret'),
      (x) => (x.media.duration = NaN),
      (x) => (x.media.path = '/lessons/s00e00/audio/../secret'),
      (x) => (x.cues[0].start = -1),
      (x) => (x.cues[1].start = 2),
      (x) => (x.cues[0].end = Infinity),
      (x) => (x.cues[0].to = 999),
      (x) => x.targets.push(x.targets[0]),
      (x) => (x.unknown = []),
      (x) => (x.cues[0].target = 'b'.repeat(64)),
    ]) {
      const bad = structuredClone(valid);
      mutate(bad);
      assert.throws(() => S.validate(bad, 's00e00'));
    }
  } finally {
    d.window.close();
  }
});

test('viewport decisions reveal off-screen text, fit visible text and align tall figures', () => {
  assert.equal(S.scrollTop({ top: 100, bottom: 180 }, 800, 400), null);
  assert.equal(S.scrollTop({ top: 700, bottom: 760 }, 800, 400), 980);
  assert.equal(S.scrollTop({ top: -50, bottom: 50 }, 800, 400), 230);
  assert.equal(S.scrollTop({ top: 100, bottom: 1500 }, 800, 400, true), null);
});

test('service worker validates top-frame sender, fixed path, missing/corrupt files and restarts', async () => {
  const d = dom();
  try {
    const data = await pack(d.window.document);
    let requests = 0;
    function worker(body = JSON.stringify(data)) {
      let listener;
      vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), {
        importScripts() {},
        LessonOverlay: S,
        chrome: {
          runtime: {
            id: 'overlay',
            getURL: (p) => 'chrome-extension://overlay/' + p,
            onMessage: { addListener: (f) => (listener = f) },
          },
        },
        fetch: async (url) => {
          requests++;
          assert.equal(url, 'chrome-extension://overlay/timings/lessons/s00e00.json');
          return new Response(body);
        },
      });
      return listener;
    }
    const sender = { id: 'overlay', frameId: 0, url: 'https://hq.mega.dev/lessons/s00e00/' };
    const msg = { type: 'lesson-timings', lesson: 's00e00' };
    const request = (listener, m = msg, s = sender) =>
      new Promise((resolve) => {
        const result = listener(m, s, resolve);
        if (result !== true) resolve('rejected');
      });
    const listener = worker();
    for (const invalid of [
      { ...sender, url: 'https://evil.example/lessons/s00e00/' },
      { ...sender, frameId: 1 },
      { ...sender, id: 'other' },
    ]) {
      assert.equal(await request(listener, msg, invalid), 'rejected');
    }
    assert.equal(await request(listener, { ...msg, lesson: '../private' }), 'rejected');
    assert.equal(requests, 0);
    assert.equal((await request(listener)).ok, true);
    assert.equal((await request(worker())).ok, true); // No memory/cache dependency after restart.
    assert.equal((await request(worker('<html>not json</html>'))).ok, false);
    assert.equal((await request(worker('x'.repeat(4_000_001)))).ok, false);
  } finally {
    d.window.close();
  }
});

test('runtime uses native play/seek/pause, manual suspend/resume, unknown gaps and disabled follow', async () => {
  const d = dom(),
    w = d.window;
  try {
    const data = await pack(w.document);
    const audio = w.document.querySelector('audio');
    let now = 1.5,
      paused = true,
      ended = false,
      y = 0,
      clock = 10000;
    Object.defineProperties(audio, {
      currentTime: { get: () => now },
      paused: { get: () => paused },
      ended: { get: () => ended },
      duration: { value: 15 },
    });
    Object.defineProperties(w, { scrollY: { get: () => y }, innerHeight: { value: 800 } });
    Object.defineProperty(w.performance, 'now', { value: () => clock });
    const scrolls = [];
    w.scrollTo = (opts) => {
      scrolls.push(opts);
      y = opts.top;
    };
    w.matchMedia = () => ({ matches: true });
    w.Range.prototype.getBoundingClientRect = () => ({ top: 700, bottom: 740 });
    for (const e of w.document.querySelectorAll('.prose *'))
      e.getBoundingClientRect = () => ({ top: 700, bottom: 1200 });
    await startRuntime(w, data);
    const button = w.document.querySelector('[data-action="follow"]');
    assert.equal(w.document.querySelector('.mega-overlay-active').tagName, 'P');
    assert.equal(scrolls.length, 0);
    const event = (name) => {
      clock += 1000;
      audio.dispatchEvent(new w.Event(name));
    };
    paused = false;
    event('play');
    assert.equal(scrolls.length, 1);
    assert.equal(scrolls[0].behavior, 'instant');
    w.dispatchEvent(new w.Event('wheel'));
    assert.match(button.textContent, /Resume/);
    now = 7.5;
    event('seeked');
    assert.equal(scrolls.length, 1);
    assert.ok(w.document.querySelector('.mega-overlay-active .figure-zoom'));
    button.click();
    assert.equal(scrolls.length, 2);
    assert.match(button.textContent, /On/);
    paused = true;
    now = 10.5;
    event('seeked');
    assert.equal(scrolls.length, 2);
    assert.match(w.document.querySelector('.mega-overlay-active').textContent, /Last/);
    event('pause');
    assert.ok(w.document.querySelector('.mega-overlay-active'));
    now = 3.5;
    event('seeked');
    assert.equal(w.document.querySelector('.mega-overlay-active'), null);
    button.click();
    assert.match(button.textContent, /Enable/);
    now = 1.5;
    paused = false;
    event('play');
    assert.equal(w.document.querySelector('.mega-overlay-active'), null);
    button.click();
    assert.ok(w.document.querySelector('.mega-overlay-active'));
    ended = true;
    event('ended');
    assert.equal(w.document.querySelector('.mega-overlay-active'), null);
    assert.equal(w.document.activeElement, w.document.body);
    assert.equal(w.document.querySelectorAll('.mega-overlay-controls').length, 1);
  } finally {
    w.dispatchEvent(new w.Event('pagehide'));
    w.close();
  }
});

test('runtime refuses changed article/media and releases old listeners when content is replaced', async () => {
  for (const change of ['article', 'media']) {
    const d = dom(),
      w = d.window;
    try {
      const data = await pack(w.document);
      const audio = w.document.querySelector('audio');
      Object.defineProperties(audio, {
        currentTime: { value: 1.5 },
        paused: { value: true },
        duration: { value: 15 },
      });
      await startRuntime(w, data);
      if (change === 'article')
        w.document.querySelector('.prose p').textContent = 'The site changed this paragraph.';
      else {
        audio.src = '/lessons/s00e00/audio/revised.mp3';
        audio.dispatchEvent(new w.Event('emptied'));
      }
      await waitFor(() =>
        /changed/.test(w.document.querySelector('.mega-overlay-controls')?.textContent),
      );
      assert.equal(w.document.querySelector('.mega-overlay-active'), null);
      assert.equal(w.document.querySelectorAll('.mega-overlay-controls').length, 1);
    } finally {
      w.dispatchEvent(new w.Event('pagehide'));
      w.close();
    }
  }
});

test('color defaults to the original teal, previews immediately, persists across lessons and resets', async () => {
  const first = dom();
  const next = dom(html.replaceAll('s00e00', 's00e01'), 's00e01');
  const storage = colorStorage();
  try {
    for (const page of [first, next]) {
      Object.defineProperties(page.window.document.querySelector('audio'), {
        currentTime: { value: 1.5 },
        paused: { value: true },
        duration: { value: 15 },
      });
    }
    await startRuntime(first.window, await pack(first.window.document), storage);
    const picker = first.window.document.querySelector('input[type="color"]');
    const article = first.window.document.querySelector('.prose');
    const highlight = first.window.document.querySelector('.mega-overlay-active');
    assert.equal(picker.value, '#2d969b');
    assert.equal(article.style.getPropertyValue('--mega-overlay-rgb'), '45, 150, 155');

    picker.value = '#f0a020';
    picker.dispatchEvent(new first.window.Event('input'));
    assert.equal(article.style.getPropertyValue('--mega-overlay-rgb'), '240, 160, 32');
    assert.equal((await storage.get()).highlightColor, undefined); // Preview does not write on every drag.
    picker.dispatchEvent(new first.window.Event('change'));
    await waitFor(() => article.style.getPropertyValue('--mega-overlay-rgb') === '240, 160, 32');
    await flush();
    assert.equal((await storage.get()).highlightColor, '#f0a020');
    assert.equal(first.window.document.querySelector('.mega-overlay-active'), highlight);

    await startRuntime(next.window, await pack(next.window.document), storage);
    assert.equal(next.window.document.querySelector('input[type="color"]').value, '#f0a020');
    assert.equal(
      next.window.document.querySelector('.prose').style.getPropertyValue('--mega-overlay-rgb'),
      '240, 160, 32',
    );
    next.window.document.querySelector('.mega-overlay-color-controls button').click();
    await flush();
    assert.equal(next.window.document.querySelector('input[type="color"]').value, '#2d969b');
    assert.equal((await storage.get()).highlightColor, '#2d969b');
    assert.ok(next.window.document.querySelector('.mega-overlay-active'));
  } finally {
    for (const page of [first, next]) {
      page.window.dispatchEvent(new page.window.Event('pagehide'));
      page.window.close();
    }
  }
});

test('invalid saved colors and storage failures do not disable audio follow', async () => {
  for (const brokenRead of [false, true]) {
    const page = dom();
    const w = page.window;
    try {
      Object.defineProperties(w.document.querySelector('audio'), {
        currentTime: { value: 1.5 },
        paused: { value: true },
        duration: { value: 15 },
      });
      const storage = {
        get: async () => {
          if (brokenRead) throw Error('storage unavailable');
          return { highlightColor: 'red; arbitrary css' };
        },
        set: async () => {
          throw Error('storage unavailable');
        },
      };
      await startRuntime(w, await pack(w.document), storage);
      const picker = w.document.querySelector('input[type="color"]');
      assert.equal(picker.value, '#2d969b');
      assert.ok(w.document.querySelector('.mega-overlay-active'));
      picker.value = '#663399';
      picker.dispatchEvent(new w.Event('input'));
      picker.dispatchEvent(new w.Event('change'));
      await waitFor(() =>
        /could not be saved/.test(w.document.querySelector('[role="status"]').textContent),
      );
      assert.equal(
        w.document.querySelector('.prose').style.getPropertyValue('--mega-overlay-rgb'),
        '102, 51, 153',
      );
      assert.equal(w.document.querySelector('[data-action="follow"]').disabled, false);
    } finally {
      w.dispatchEvent(new w.Event('pagehide'));
      w.close();
    }
  }
});

test('late color loading cannot change a detached article or replace a newer attachment', async () => {
  const page = dom();
  const w = page.window;
  let finishOldRead;
  try {
    Object.defineProperties(w.document.querySelector('audio'), {
      currentTime: { value: 1.5 },
      paused: { value: true },
      duration: { value: 15 },
    });
    const data = await pack(w.document);
    let reads = 0;
    w.chrome = {
      runtime: {
        sendMessage: async () => ({ ok: true, data }),
        getManifest: () => ({ version: 'test' }),
      },
      storage: {
        local: {
          get: () =>
            ++reads === 1
              ? new Promise((resolve) => {
                  finishOldRead = resolve;
                })
              : Promise.resolve({ highlightColor: '#112233' }),
          set: async () => {},
        },
      },
    };
    w.eval(fs.readFileSync(require.resolve('../shared.js'), 'utf8'));
    w.eval(fs.readFileSync(require.resolve('../content.js'), 'utf8'));
    await waitFor(() => w.document.querySelector('[data-action="follow"]')?.disabled === false);
    const oldArticle = w.document.querySelector('.prose');
    const newArticle = oldArticle.cloneNode(true);
    oldArticle.replaceWith(newArticle);
    await waitFor(() => w.document.querySelector('input[type="color"]')?.value === '#112233');
    finishOldRead({ highlightColor: '#abcdef' });
    await flush();
    assert.equal(newArticle.style.getPropertyValue('--mega-overlay-rgb'), '17, 34, 51');
    assert.equal(oldArticle.style.getPropertyValue('--mega-overlay-rgb'), '');
    assert.equal(w.document.querySelectorAll('.mega-overlay-controls').length, 1);
    await waitFor(() => w.document.querySelector('[data-action="follow"]').disabled === false);
    assert.equal(w.document.querySelector('[data-action="follow"]').disabled, false);
  } finally {
    w.dispatchEvent(new w.Event('pagehide'));
    w.close();
  }
});
