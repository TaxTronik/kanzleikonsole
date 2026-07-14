import assert from 'node:assert/strict';
import { verifyReleaseVersion } from '../verify-release-version.mjs';

const valid = {
  tag: 'v0.2.0',
  packageJson: JSON.stringify({ version: '0.2.0' }),
  changelog: '# Changelog\n\n## [0.2.0] - 2026-07-14\n',
};

assert.equal(verifyReleaseVersion(valid), '0.2.0');
assert.throws(() => verifyReleaseVersion({ ...valid, tag: '0.2.0' }), /vX\.Y\.Z/);
assert.throws(
  () => verifyReleaseVersion({ ...valid, packageJson: JSON.stringify({ version: '0.1.0' }) }),
  /stimmt nicht mit package\.json/,
);
assert.throws(
  () => verifyReleaseVersion({ ...valid, changelog: '# Changelog\n\n## [Unreleased]\n' }),
  /keinen datierten Abschnitt/,
);

process.stdout.write('4 release-version tests passed.\n');
