# Repository instructions

This repository contains a browser extension that follows MEGA.dev lesson audio. Read [README.md](README.md) for installation and use, [prepare/README.md](prepare/README.md) for the maintainer workflow, and [timings/README.md](timings/README.md) for the private pack layout.

## Prepare a lesson

1. Confirm the lesson ID and URL. Follow the commands in the [new-lesson checklist](prepare/README.md#checklist-for-each-new-lesson).
2. Run preparation, inspect the report, validate the pack and check that a cached rerun reproduces the generated files.
3. Compare every untimed figure and untimed or partly timed text target with the WhisperX word alignment. Follow the [manual timing review](prepare/README.md#manual-timing-review). Aligned transcript evidence is sufficient when it identifies the target and time range; audio listening is optional. Leave ambiguous or unspoken content untimed.
4. Record the evidence and remaining gaps in a private report. Validate and publish any reviewed candidate to the local pack using the maintainer guide, then run its browser playback checks. Report checks that could not run.

The pipeline captures article HTML but does not make every HTML element a target. It selects headings, paragraphs, list items and figures, and can leave some of those or parts of their text untimed. Do not invent timestamps for silence, unspoken content or uncertain matches.

Keep audio, article captures, transcripts, browser profiles and reports in `.private/`. Keep timing files in `timings/`. Do not commit or publish private course material, and do not use lesson completion, challenge or story controls during preparation.
