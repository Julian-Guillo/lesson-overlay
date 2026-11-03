// Private integration runner: reads supplied local artifacts; never creates a public fixture.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const S = require('../shared.js');
const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
async function check(snapshotPath, dataPath) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const data = S.validate(JSON.parse(fs.readFileSync(dataPath, 'utf8')), snapshot.lesson);
  const markup = snapshot.blocks
    .map((b) => {
      const text = escape(b.text);
      if (b.kind === 'figure')
        return `<p><a class="figure-zoom" href="${escape(b.figure)}"><img alt=""><img alt=""></a></p>`;
      if (b.kind === 'heading') return `<h2 id="${escape(b.section)}">${text}</h2>`;
      if (b.kind === 'item') return `<ul><li>${text}</li></ul>`;
      return `<p>${text}</p>`;
    })
    .join('');
  const d = new JSDOM(
    `<audio class="lesson-audio-media" src="${escape(data.media.path)}"></audio><article class="lesson-article"><div class="prose">${markup}</div></article>`,
    {
      url: `https://hq.mega.dev/lessons/${snapshot.lesson}/`,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  );
  const w = d.window;
  try {
    w.TextEncoder = TextEncoder;
    Object.defineProperty(w.crypto, 'subtle', { value: webcrypto.subtle });
    w.chrome = {
      runtime: {
        sendMessage: async () => ({ ok: true, data }),
        getManifest: () => ({ version: 'test' }),
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    };
    let time = 0;
    const audio = w.document.querySelector('audio');
    Object.defineProperties(audio, {
      currentTime: { get: () => time },
      paused: { value: true },
      duration: { value: data.media.duration },
    });
    w.eval(fs.readFileSync(require.resolve('../shared.js'), 'utf8'));
    w.eval(fs.readFileSync(require.resolve('../content.js'), 'utf8'));
    for (
      let i = 0;
      i < 100 && !w.document.querySelector('[data-action="follow"]:not(:disabled)');
      i++
    )
      await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      w.document.querySelector('[data-action="follow"]:not(:disabled)'),
      'Private fixture did not resolve',
    );
    const targets = await S.identify(S.snapshot(w.document));
    assert.equal(await S.fingerprint(targets), data.article);
    const map = new Map(targets.map((t) => [t.key, t.element]));
    // Every cue, its endpoint, every gap, and reverse order seeking exercise the actual content script.
    const times = [
      ...data.cues.flatMap((c) => [c.start, (c.start + c.end) / 2, c.end]),
      ...data.unknown.map(([a, z]) => (a + z) / 2),
    ].reverse();
    for (const t of times) {
      time = t;
      audio.dispatchEvent(new w.Event('seeked'));
      const cue = S.cueAt(data.cues, t);
      assert.equal(
        w.document.querySelector('.mega-overlay-active'),
        cue ? map.get(cue.target) : null,
        `Wrong element at ${t}`,
      );
    }
    assert.equal(w.document.querySelectorAll('.mega-overlay-controls').length, 1);
    return { targets: targets.length, cues: data.cues.length, clock_checks: times.length };
  } finally {
    w.dispatchEvent(new w.Event('pagehide'));
    w.close();
  }
}
if (require.main === module)
  check(process.argv[2], process.argv[3])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
module.exports = check;
