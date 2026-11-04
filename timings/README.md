# Install the private timing pack

Copy the private pack into this folder with this layout:

```text
timings/
  manifest.json
  lessons/
    <lesson-id>.json
```

This folder's `manifest.json` lists the timing files. It is separate from the extension manifest at the repository root. Git ignores the private timing JSON and pack inventory. Share them only through the private course group. Leave out raw media, transcripts and `.private/`.

After copying an update, reload the extension on the browser's extensions page and refresh the lesson tab. Recipients do not need scripts or build tools.

To generate or review a pack, follow the [new-lesson checklist](../prepare/README.md#checklist-for-each-new-lesson), including the [manual timing review](../prepare/README.md#manual-timing-review).
