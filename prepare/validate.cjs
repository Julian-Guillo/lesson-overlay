// Use the extension's validator for every prepared/exported file.
const fs = require('node:fs');
const shared = require('../shared.js');

async function validateFile(dataPath, snapshotPath) {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  shared.validate(data, data.lesson);
  if (!snapshotPath) return;

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const targets = await shared.identify(
    snapshot.blocks.map((block) => ({
      ...block,
      identity: block.kind === 'figure' ? block.figure : shared.normalize(block.text),
    })),
  );
  const fingerprint = await shared.fingerprint(targets);
  if (
    fingerprint !== data.article ||
    targets.length !== data.targets.length ||
    targets.some((target, i) => target.key !== data.targets[i].key)
  ) {
    throw Error('Capture fingerprint mismatch');
  }
}

validateFile(process.argv[2], process.argv[3]).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
