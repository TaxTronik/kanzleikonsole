// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

for (const scenario of ['occupied', 'unavailable']) {
  test(`Release-Smoke führt bei ${scenario} ausschließlich die Bestandsabfrage aus`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'release-smoke-preflight-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = join(dir, 'calls');
    writeFileSync(
      join(dir, 'docker'),
      [
        '#!/usr/bin/env bash',
        'echo "$1" >> "${BASH_SOURCE[0]%/*}/calls"',
        '[[ $1 == ps ]] || exit 99',
        scenario === 'occupied' ? 'printf "%s\\n" unrelated taxtronik-existing' : 'exit 31',
      ].join('\n') + '\n',
      { mode: 0o700 },
    );
    const result = spawnSync(
      'bash',
      [
        'scripts/release/smoke-release-images.sh',
        '--web-image',
        'example/web',
        '--worker-image',
        'example/worker',
        '--expected-revision',
        'test',
      ],
      {
        env: {
          ...process.env,
          PATH: dir + delimiter + process.env.PATH,
        },
        encoding: 'utf8',
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, scenario === 'occupied' ? 1 : 31, result.stderr);
    assert.equal(readFileSync(calls, 'utf8').trim(), 'ps');
  });
}
