import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { verifyReleaseConfig } from '../verify-release-config.mjs';

const { privateKey: ed25519Key } = generateKeyPairSync('ed25519');
const validEnv = {
  UPDATE_MANIFEST_REPO: 'https://git.example.test/TaxTronik/updates.git',
  UPDATE_MANIFEST_TOKEN: 'test-token',
  UPDATE_MANIFEST_PRIVATE_KEY: ed25519Key.export({ format: 'pem', type: 'pkcs8' }).toString(),
};

assert.equal(
  verifyReleaseConfig(validEnv).manifestRepo,
  'https://git.example.test/TaxTronik/updates.git',
);
assert.equal(
  verifyReleaseConfig({
    ...validEnv,
    UPDATE_MANIFEST_PRIVATE_KEY: validEnv.UPDATE_MANIFEST_PRIVATE_KEY.replaceAll('\n', '\\n'),
  }).manifestRepo,
  'https://git.example.test/TaxTronik/updates.git',
);

assert.throws(
  () => verifyReleaseConfig({ ...validEnv, UPDATE_MANIFEST_TOKEN: '' }),
  /UPDATE_MANIFEST_TOKEN fehlt/,
);
assert.throws(
  () =>
    verifyReleaseConfig({ ...validEnv, UPDATE_MANIFEST_REPO: 'http://git.example.test/updates' }),
  /muss HTTPS verwenden/,
);
assert.throws(
  () =>
    verifyReleaseConfig({
      ...validEnv,
      UPDATE_MANIFEST_REPO: 'https://token@git.example.test/updates?unsafe=1',
    }),
  /keine Credentials, Query oder Fragment/,
);

const { privateKey: rsaKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
assert.throws(
  () =>
    verifyReleaseConfig({
      ...validEnv,
      UPDATE_MANIFEST_PRIVATE_KEY: rsaKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    }),
  /muss ein Ed25519-Schlüssel sein/,
);

process.stdout.write('5 release-config tests passed.\n');
