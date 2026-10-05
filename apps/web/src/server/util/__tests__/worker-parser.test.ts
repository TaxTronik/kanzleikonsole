// P-22/P-13: Begrenzte Worker-Threads lösen ihren Parser selbst auf. Turbopack
// ersetzt require.resolve('…') im Produktionsbuild durch eine Modul-ID, die ein
// Worker-Thread nicht laden kann; der Servercode darf Parserpfade deshalb nicht
// so ermitteln.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

import { LOAD_PARSER_SOURCE, WORKER_PARSER_PACKAGES, workerParserBases } from '../worker-parser';

function loadInThread(
  name: string,
  parserBases: string[],
): Promise<{ ok: boolean; type?: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
const { parentPort, workerData } = require('node:worker_threads');
${LOAD_PARSER_SOURCE}
try {
  parentPort.postMessage({ ok: true, type: typeof loadParser(workerData.name) });
} catch {
  parentPort.postMessage({ ok: false });
}
`,
      { eval: true, workerData: { name, parserBases } },
    );
    worker.once('message', (message: { ok: boolean; type?: string }) => {
      void worker.terminate();
      resolve(message);
    });
    worker.once('error', reject);
  });
}

function serverSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : serverSources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('Parser in begrenzten Worker-Threads', () => {
  it.each(WORKER_PARSER_PACKAGES)('lädt %s im Thread über die Laufzeit-Suchpfade', async (name) => {
    expect(await loadInThread(name, workerParserBases())).toEqual({ ok: true, type: 'object' });
  });

  it('meldet einen nicht auffindbaren Parser als Fehler', async () => {
    expect(await loadInThread('taxtronik-parser-gibt-es-nicht', workerParserBases())).toEqual({
      ok: false,
    });
  });

  it('ermittelt im Servercode keine Modulpfade per require.resolve', () => {
    const srcRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const offenders = serverSources(srcRoot).filter((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => !/^\s*(\/\/|\*)/.test(line) && /\brequire\.resolve\s*\(/.test(line)),
    );
    expect(offenders).toEqual([]);
  });
});
