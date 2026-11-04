# Lesson audio follow

A local browser extension for [MEGA.dev lessons](https://hq.mega.dev/lessons/). It highlights lesson text and diagrams as the lesson audio plays, and scrolls to keep the current passage visible.

## Install

1. Download or clone this repository and keep it in a permanent folder.
2. Add the private timing pack as shown below. The repository does not include lesson timestamps.
3. Open `chrome://extensions`, `brave://extensions`, or `edge://extensions` in your browser.
4. Enable **Developer mode**, click **Load unpacked**, and select the `lesson-overlay` folder containing the top-level `manifest.json`.
5. Open or refresh a MEGA.dev lesson page.

No build, npm install, or Python setup is needed to use the extension.

## Add the timestamps

Get the prepared timing pack from the course colleague who maintains it. Copy its contents into `timings/` at the repository root:

```text
lesson-overlay/
  manifest.json          # Browser extension configuration
  content.js
  timings/
    manifest.json        # Timing pack inventory
    lessons/
      s01e05.json         # Timings for lesson s01e05
      <lesson-id>.json    # One file per supported lesson
```

The lesson ID comes from its URL, for example `s01e05` in `/lessons/s01e05`. Keep the two `manifest.json` files in their separate folders. Avoid an extra `timings/timings/` folder.

After adding or replacing timing files, click **Reload** on the extension's card in the extensions page, then refresh the lesson tab. Repeat this after updating the extension code.

If the extension reports "No valid timings", check that the current lesson has a matching JSON file under `timings/lessons/`. If it reports changed audio or article text, ask the maintainer for fresh timings.

Timing files are private and excluded from Git. Share the prepared `timings/` pack only with the private course group. Never share `.private/`, which contains source material and browser sign-in data.

## Use

Press **Play** in **Listen to this lesson**, beneath the video. The extension follows this audio player, not the video soundtrack.

- Use the bottom-right control to turn following on or off and change the highlight color.
- Manual scrolling pauses automatic scrolling. Click **Resume following** to continue.
- Pausing keeps the current highlight. Seeking and playback speed changes update it automatically.
- Lessons with partial timing coverage leave gaps unhighlighted.

## Prepare timings or develop

To prepare a new lesson, follow the [new-lesson checklist](prepare/README.md#checklist-for-each-new-lesson). After generation and validation, use the [manual timing review](prepare/README.md#manual-timing-review) to compare untimed figures and text with the WhisperX word alignment. The maintainer guide also covers setup, browser capture and development checks. Repository agent instructions are in [AGENTS.md](AGENTS.md).
