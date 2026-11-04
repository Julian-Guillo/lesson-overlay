# Prepare lesson timings

Start with the [new-lesson checklist](#checklist-for-each-new-lesson). After the automated checks, complete the [manual timing review](#manual-timing-review) using the WhisperX word alignment.

The maintainer CLI runs on Linux and macOS. It requires Node 20+, Python 3.11 through 3.13, `uv`, `ffmpeg` and `ffprobe`. Run the commands below from the repository root. The browser extension has no runtime dependencies.

One-time setup:

```bash
npm ci --ignore-scripts
uv sync --project prepare --extra speech --frozen
uv run --project prepare --extra speech --frozen playwright install chromium
```

The command uses a separate browser profile in `.private/browser-profile/`. To use an installed Chromium-based browser for sign-in and capture, add `--browser /path/to/browser`. It will use the same preparation profile, not your everyday browser session. On a minimal Linux system, follow Playwright's instructions to install any missing system libraries.

Prepare a lesson:

```bash
uv run --project prepare --extra speech --frozen python -m lesson_overlay prepare <lesson-id>
uv run --project prepare --frozen python -m lesson_overlay check-pack
```

Replace `<lesson-id>` with the ID from the lesson URL. If sign-in is needed or the lesson is unavailable, a preparation browser window opens. Sign in there if needed, then close the window; the command retries capture once. If the lesson is still unavailable or access is refused, it stops with an error. You can also sign in ahead of time with `uv run --project prepare --extra speech --frozen python -m lesson_overlay login`. Preparation does not use completion or story controls.

The pipeline saves the live article HTML, extracts supported article targets and hashes the snapshot and lesson MP3. The DOM adapter selects headings, paragraphs, list items and figures. It excludes player controls, duplicate images and standalone resource links. The pipeline transcribes the audio locally with a pinned small model, then uses forced alignment to refine word times. It matches the transcript to article text in order and checks chapter times and ambiguous matches. Before export, it runs the extension content script against a private DOM fixture rebuilt from the capture. A figure cue needs matching alt-label text and a position between neighboring prose targets that identifies a single figure. Uncertain intervals stay empty. Not every HTML element becomes a target, and not every target or sentence receives a cue.

If usable prose coverage is below 90% or chapter anchors disagree, the pipeline retries the full audio once with a pinned medium model. It keeps the better valid result. If the retry fails, it can still export the original valid partial result. It exports nothing below 70% coverage. These checks measure coverage and consistency; they do not establish that every cue matches the speech.

The first run downloads models from Hugging Face and PyTorch. The pipeline processes audio and course text locally. CPU inference can take several minutes. Model dependencies and weights need several GB of disk space. The lockfile pins Python dependencies. `prepare/lesson_overlay/speech.py` pins transcription model revisions and the alignment weight hash. Models and cached results stay in `.private/models/` and `.private/cache/`. Bump `PIPELINE` when changing model revisions or how a cached stage works. Fresh inference can produce different numbers on different hardware.

Before export, the pipeline checks the schema, source, cues, fingerprint and private runtime results. It replaces the lesson file atomically and allows only one preparation job to update the pack at a time. If generation or checks fail, it keeps the previous files. `timings/manifest.json` lists file hashes and revisions. Run `check-pack` to detect corrupt or mismatched copies. Reports are in `.private/reports/`.

Local transcription and alignment passed for S02E02 on 2026-11-03 with an article capture and audio download from a signed-in Brave session. A cached rerun produced identical timing files. Capture through the dedicated preparation browser profile passed for S02E03 on 2026-11-04. The S01E05 pilot uses imported alignment. See [Preparation inputs and recovery](#preparation-inputs-and-recovery) for the browser capture steps.

## Checklist for each new lesson

1. Confirm the requested lesson on the signed-in course page. For "today's" or "latest", check the live lessons listing and its availability date. Record the lesson ID and URL.
2. Run the preparation command above and sign in when prompted. If browser capture fails, use the [signed-in browser capture recipe](#signed-in-browser-capture). Download the exact lesson audio, capture the live article and chapter markers, and save them under `.private/captures/<lesson-id>/`. Use the native audio beneath the video.
3. Run preparation with the captured inputs. The pipeline runs faster-whisper small on CPU, aligns words with WhisperX, and matches timestamps to paragraphs, list items, headings and diagrams. Let the coverage checks decide whether to retry with the medium model. Leave uncertain intervals empty. Do not invent timestamps or tune thresholds for a lesson.
4. Read `.private/reports/<lesson-id>.json`. Check text coverage, figure coverage, chapter disagreements, retry results and `runtime_checks`. Confirm that the run exported `timings/lessons/<lesson-id>.json` and that `check-pack` passes. A failed run may leave an older file in place.
5. Save the first report and SHA-256 hashes of the lesson file and `timings/manifest.json`. Rerun preparation with the captured snapshot and audio, as shown below. Confirm the output says it reused the alignment cache and both hashes match. Stop and investigate a mismatch. Do this before manual edits because preparation replaces the lesson file and report.
6. Review all untimed figures and other supported targets, including partly timed text. Follow [manual timing review](#manual-timing-review), validate any changes and record unresolved gaps. Do this after the cached rerun because preparation overwrites manual changes.
7. Run the [development checks](#development-checks) after changes to code or dependencies. Each preparation already runs schema validation and the private DOM/clock checks before export.
8. Reload the extension and refresh the lesson. Confirm the displayed data revision matches the export. Use the native player to check playback, pause and chapter seeks near the beginning, middle and end. Check a list or diagram when available. Save screenshots and browser observations in `.private/reports/`. Report any browser check you could not run; automated DOM checks do not replace it.
9. Leave playback paused at the beginning. Record the result and remaining gaps, then tell the recipient to reload the extension, refresh the lesson and test it. No listening approval is required before export. Never mark the lesson done, submit a challenge or use story controls as part of timestamp preparation.

Keep media, article captures, transcripts, models and reports in `.private/`. Only the generated timing pack belongs in `timings/`. Share or publish files only when requested.

For step 5, replace `s00e00` with the lesson ID. Preserve any options that affected the first run, such as `--no-retry`.

```bash
lesson=s00e00
cp ".private/reports/$lesson.json" ".private/reports/$lesson-first.json"
sha256sum "timings/lessons/$lesson.json" timings/manifest.json > ".private/reports/$lesson-first.sha256"
uv run --project prepare --extra speech --frozen python -m lesson_overlay prepare "$lesson" \
  --snapshot ".private/captures/$lesson/snapshot.json" \
  --audio ".private/captures/$lesson/audio.mp3"
sha256sum -c ".private/reports/$lesson-first.sha256"
```

## Manual timing review

Perform this review after preparation, `check-pack` and the cached reproducibility check pass. Compare `.private/captures/<lesson-id>/article.html` and `snapshot.json` with the exported targets and cues. `lesson_overlay.mapping.identify` derives each target key from the snapshot blocks. Check figures without cues, text targets without cues, and text ranges not covered by a cue. A timed target may still have untimed sentences. Inspect other article HTML for meaningful spoken content that the adapter did not select. Some HTML, such as player controls and standalone links, has no target and cannot receive a cue in the current format. Record any unsupported spoken content and consider whether the adapter needs a separate change. Do not invent targets.

To list the gaps, replace `s00e00` below with the lesson ID. The output contains private lesson content. For text, missing indexes refer to `TOKEN` matches in the target text.

```bash
prepare/.venv/bin/python - s00e00 <<'PY'
import json
import sys
from pathlib import Path
from lesson_overlay.mapping import TOKEN, identify

lesson = sys.argv[1]
snapshot = json.loads(Path(f'.private/captures/{lesson}/snapshot.json').read_text())
data = json.loads(Path(f'timings/lessons/{lesson}.json').read_text())
for index, block in enumerate(identify(snapshot['blocks'])):
    cues = [cue for cue in data['cues'] if cue['target'] == block['key']]
    count = len(list(TOKEN.finditer(block['text']))) if block['kind'] != 'figure' else 0
    missing = [i for i in range(count) if not any(c['from'] <= i < c['to'] for c in cues)]
    if (block['kind'] == 'figure' and not cues) or missing:
        print(index, block['kind'], 'missing:', missing, 'key:', block['key'])
        print(block.get('alt') if block['kind'] == 'figure' else block['text'])
PY
```

Find the cached WhisperX alignment using the audio hash and pipeline version from the report. The command below prints the available alignment files and verifies their source hashes. Replace `s00e00` with the lesson ID.

```bash
prepare/.venv/bin/python - s00e00 <<'PY'
import json
import sys
from pathlib import Path
from lesson_overlay.mapping import build, digest

lesson = sys.argv[1]
report = json.loads(Path(f'.private/reports/{lesson}.json').read_text())
snapshot = json.loads(Path(f'.private/captures/{lesson}/snapshot.json').read_text())
data = json.loads(Path(f'timings/lessons/{lesson}.json').read_text())
cache = Path('.private/cache') / digest(report['audio_sha256'] + report['pipeline'])
for path in sorted(cache.glob('aligned-*.json')):
    alignment = json.loads(path.read_text())
    if alignment.get('source_sha256') != report['audio_sha256']:
        raise ValueError(f'Audio hash mismatch: {path}')
    rebuilt, _ = build(snapshot, alignment, report['audio_sha256'], data['media']['duration'])
    print(path, 'matches automatic revision:', rebuilt['revision'] == data['revision'])
if not list(cache.glob('aligned-*.json')):
    raise ValueError('No cached alignment found')
PY
```

Each alignment contains segments with text and `words`, where each word may have `start` and `end` in seconds. Inspect those words around each untimed target and compare their text with the article, figure alt text and neighboring cues. If both small and medium alignments exist, the report does not identify which one won. The command rebuilds each candidate and compares its revision with the automatic lesson file. Investigate if neither matches. The aligned transcript and word times are sufficient evidence when they identify the target and support the interval. Listening to the audio is optional, and the report must say whether it occurred.

Add a cue only when the spoken content identifies the target and supports its start and end. A clear paraphrase can support a cue. Use neighboring cues, chapter markers and figure alt text as context, not as proof of a time. If a figure is not described, or the evidence is ambiguous, leave it untimed. Do not fill silence or assign the same interval to multiple targets. Check for overlapping word times, and leave an uncertain boundary untimed. If a correction requires changing an existing cue, preserve non-overlapping, ordered intervals and record the evidence for both changes.

Copy `timings/lessons/<lesson-id>.json` to `.private/reports/<lesson-id>-reviewed.json`. Add reviewed cues with the existing target key. For text, `from` and `to` are the half-open token range in that target, based on `lesson_overlay.mapping.TOKEN`. For a figure, both are zero. Keep times in seconds within the audio duration. Save a private review report with each reviewed target, the source alignment, evidence, decision and remaining gaps. State whether audio was heard. The generated report and its coverage figures describe the automatic run, not the manual review.

The following command sorts the candidate cues, recalculates unknown intervals and the revision, checks the original pack, validates the candidate against the snapshot and runs the private DOM and clock checks. It then replaces the lesson file and updates the manifest under the preparation lock. Replace `s00e00` and put the reviewed copy at the indicated candidate path first.

```bash
prepare/.venv/bin/python - s00e00 <<'PY'
import json
import subprocess
import sys
from pathlib import Path

from lesson_overlay.__main__ import ID, PACK, PRIVATE, atomic_json, check_pack, inventory, lock, validate_file
from lesson_overlay.mapping import complement, digest, js_json

lesson = sys.argv[1]
if not ID.fullmatch(lesson):
    raise ValueError('Invalid lesson ID')
candidate = PRIVATE / 'reports' / f'{lesson}-reviewed.json'
snapshot = PRIVATE / 'captures' / lesson / 'snapshot.json'
target = PACK / 'lessons' / f'{lesson}.json'
with lock():
    check_pack()
    original = json.loads(target.read_text())
    original_manifest = json.loads((PACK / 'manifest.json').read_text())
    data = json.loads(candidate.read_text())
    for key in ('schema', 'normalization', 'lesson', 'media', 'article', 'targets', 'status', 'checks'):
        if data[key] != original[key]:
            raise ValueError(f'Unexpected change to {key}')
    data['cues'].sort(key=lambda cue: (cue['start'], cue['end']))
    data['unknown'] = complement(data['cues'], data['media']['duration'])
    data['revision'] = ''
    data['revision'] = digest(js_json(data))[:12]
    atomic_json(candidate, data)
    validate_file(candidate, snapshot)
    subprocess.run(['node', 'tests/check-lesson.cjs', str(snapshot), str(candidate)], check=True)
    try:
        atomic_json(target, data)
        atomic_json(PACK / 'manifest.json', inventory())
        check_pack()
    except Exception:
        atomic_json(target, original)
        atomic_json(PACK / 'manifest.json', original_manifest)
        raise
PY
```

The checks establish schema, target resolution and clock behavior. They do not establish that a cue matches the speech. Do not rerun preparation after publishing the reviewed candidate without repeating this review: it regenerates the automatic timing file and report.

## Development checks

```bash
npm ci --ignore-scripts
npm test
npm run format:check
python3 -m unittest discover -s tests -p 'test_*.py' -v
uv run --project prepare --frozen python -m lesson_overlay check-pack
```

Public tests use synthetic content. They cover clock and gap lookup, target matching, nested lists, paragraph splits, repeated text, diagrams, manual scrolling, reduced motion, pause and seek behavior, sender validation, worker restart, malformed data and failed atomic writes. They also check highlight color defaults, persistence, reset and storage failures. Each prepared lesson gets private DOM and clock checks. Test the unpacked extension in each browser as well. Automated checks cannot confirm that every cue matches the speech.

Run `npm run format` to format JavaScript, CSS and JSON. Prettier is a development dependency only. Python uses Ruff's standard formatting and import order. Optional checks are `uvx ruff==0.14.3 format --check prepare/lesson_overlay tests/test_prepare.py` and `uvx ruff==0.14.3 check --select F,I prepare/lesson_overlay tests/test_prepare.py`.

`shared.js` contains the DOM adapter, token normalization, identities, fingerprints and validator. `background.js` reads extension-local lesson JSON through internal messages. It has no web-accessible resources, host API calls or analytics.

`content.js` handles color controls, playback, scrolling, asynchronous setup and page cleanup in separate functions. It uses the `storage` permission to save the highlight color locally. It adds a CSS class and scrolls to the current sentence. It does not wrap or replace site text or move keyboard focus.

`prepare/validate.cjs` lets the Python CLI use the runtime validator. At runtime, the extension checks the source path, duration and article fingerprint. It does not download and hash the audio again, so it cannot detect changed audio bytes if the URL and duration stay the same.

The generic code is intended for a future public repository. This implementation has not set up a remote or published files. Before publishing, review the file list and Git history. Never commit timing JSON, captured fixtures, media, sessions or reports. Do not run `git clean -fdx` in a checkout that contains the private pack.

Implementation references: [Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [unpacked installation](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world), [Edge installation](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading), [Brave extensions](https://support.brave.app/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave), [Playwright authentication](https://playwright.dev/python/docs/auth), [WhisperX](https://github.com/m-bain/whisperX).

## Preparation inputs and recovery

### Signed-in browser capture

These capture steps were verified on 2026-11-03. Use the supported browser connector to open the requested lesson in an existing signed-in session. Click "Download audio" and save or copy the downloaded MP3 to `.private/captures/<lesson-id>/audio.mp3`. If access is refused, use the normal course sign-in flow; do not copy cookies or change request headers.

Read the page DOM and save the result of this expression as `browser-capture.json` in the same folder. Use a read-only browser evaluation, then write its result to a local file through the available tools.

```javascript
() => ({
  article: document.querySelector('.lesson-article').outerHTML,
  media: document.querySelector('audio.lesson-audio-media').getAttribute('src'),
  chapters: Array.from(document.querySelectorAll('[data-start][data-heading]'), element => ({
    start: Number(element.getAttribute('data-start')),
    heading: element.getAttribute('data-heading'),
  })),
  title: document.title,
  url: location.href,
})
```

Convert the captured HTML with the extension's shared DOM adapter. The adapter preserves paragraph boundaries and excludes duplicate images, player controls and companion links. Replace `s00e00` with the requested lesson ID and run from the repository root:

```bash
node - s00e00 <<'JS'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const S = require('./shared.js');
const lesson = process.argv[2];
assert.match(lesson, /^s\d{2}e\d{2}$/);
const folder = `.private/captures/${lesson}`;
const capture = JSON.parse(fs.readFileSync(`${folder}/browser-capture.json`, 'utf8'));
assert.equal(S.lessonId(capture.url), lesson);
const dom = new JSDOM(capture.article);
const blocks = S.snapshot(dom.window.document).map(({ element, parts, identity, ...block }) => ({
  ...block,
  ...(block.kind === 'figure' ? { figure: identity } : {}),
}));
fs.writeFileSync(`${folder}/article.html`, capture.article);
fs.writeFileSync(`${folder}/snapshot.json`, JSON.stringify({
  lesson, media: capture.media, blocks, chapters: capture.chapters,
  capture: 'Signed-in browser DOM export', url: capture.url,
  title: capture.title, captured: new Date().toISOString(),
}));
dom.window.close();
JS
```

Record the browser used, capture date, audio SHA-256 and decoder versions beside the inputs. Keep screenshots and run logs private. Continue with the captured-input command below.

### Run with captured inputs

To prepare a lesson from an existing browser capture and MP3, pass their paths:

```bash
uv run --project prepare --extra speech --frozen python -m lesson_overlay prepare <lesson-id> \
  --snapshot .private/captures/<lesson-id>/snapshot.json \
  --audio .private/captures/<lesson-id>/audio.mp3
```

To reuse an aligned transcript from the exact same audio, add `--aligned /absolute/path/to/aligned.json`. The command rejects a SHA-256 mismatch. It copies the transcript into the local speech cache and keeps the original inputs. For offline imports, `--no-retry` skips medium-model inference and records that choice in the private report. Preparation retries by default.

A snapshot has this JSON structure. The example uses synthetic content:

```json
{
  "lesson": "s00e00",
  "media": "/lessons/s00e00/audio/example.mp3",
  "blocks": [
    {"kind": "heading", "section": "introduction", "text": "Introduction"},
    {"kind": "paragraph", "section": "introduction", "text": "A useful sentence."},
    {"kind": "item", "section": "introduction", "text": "An individual list item."},
    {"kind": "figure", "section": "introduction", "text": "", "figure": "/figures/demo/frame.html", "alt": "The actual diagram description."}
  ],
  "chapters": [{"heading": "introduction", "start": 0}]
}
```

Extract blocks from the live article in order with `shared.js`. Downloaded Markdown does not provide the required block boundaries. Keep punctuation so the pipeline can split sentences. Exclude the player, standalone resource links, duplicate dark and light images, `.example-local` links and repeated child-list text. Each heading starts a section identified by its DOM ID. If it has no ID, use its normalized heading text.

An aligned input contains `source_sha256` and a `segments` array. Each segment has `text` and `words: [{"word":"spoken", "start":1.2, "end":1.5}]`. Times must use seconds in the original media. The pipeline does not interpolate missing word times. It keeps raw and refined transcripts in separate private files. For imported alignment, record the models and runtime. Independently check and record that the source and transcript were preserved.

Reports explain coverage, chapter disagreements, conflicts, retries and private fixture checks. The command exports valid partial results without human sign-off. If capture, media identity, structural checks or minimum coverage fail, it exits with a nonzero code and keeps the previous output. Fix the sign-in, environment or input problem and rerun the command. Do not manually manufacture cue times to make a check pass.

Model revisions and the alignment SHA-256 are pinned in `lesson_overlay/speech.py`; `uv.lock` pins dependencies. The default maintainer browser is the Chromium build installed by the pinned Playwright version. No browser extensions are loaded in its preparation profile. The recipient browser installation remains separate.

The private integration test rebuilds the captured semantic DOM and runs the extension content script. It tests every cue, cue endpoints, gaps and reverse seeks. It checks target resolution and clock behavior. It cannot tell whether the speech describes the selected diagram. Report signed-in player tests and extension installation tests in Brave, Chrome and Edge separately.
