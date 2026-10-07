// =============================================================================
// Profilwahl in Worker und CLI-Skripten (Review-Befund K-09).
//
// Ein Profil wirkt nur, wenn es vor jeder Auswertung von @taxtronik/config
// gewählt ist: als erster Import des Einstiegsmoduls. Die Regel in
// eslint.config.mjs erzwingt das; geprüft mit der echten Konfiguration. Jedes
// Profil außer `web` hat genau einen so geschützten Einstieg.
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { ENV_PROFILES } from '../env-schema';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

// Der Import von eslint.config.mjs laedt alle Lint-Plugins, und jeder Lauf
// wertet die volle Konfiguration aus. Unter paralleler CI-Last brauchte schon
// der erste Test mehr als die 5-s-Grenze (CI-Lauf 3737: 5,8 s). Die Zeit fehlt
// keiner fachlichen Pruefung; daher eine eigene, grosszuegige Grenze je Test.
const LINT_TIMEOUT_MS = 60_000;

interface Einstieg {
  file: string;
  profile: string;
}

async function einstiege(): Promise<Einstieg[]> {
  const config = (await import(pathToFileURL(join(ROOT, 'eslint.config.mjs')).href)) as {
    ENV_PROFILE_ENTRIES: Einstieg[];
  };
  return config.ENV_PROFILE_ENTRIES;
}

async function meldungen(file: string, code?: string): Promise<string[]> {
  const filePath = join(ROOT, file);
  const [result] =
    code === undefined
      ? await eslint.lintFiles([filePath])
      : await eslint.lintText(code, { filePath });
  return result!.messages
    .filter((m) => m.ruleId === 'no-restricted-syntax')
    .map((m) => `${m.line}: ${m.message}`);
}

describe('ENV-Profilwahl als erster Import', { timeout: LINT_TIMEOUT_MS }, () => {
  it('schützt für jedes Prozessprofil außer web genau einen Einstieg', async () => {
    const liste = await einstiege();
    const profile = Object.keys(ENV_PROFILES).filter((p) => p !== 'web');
    expect(liste.map((e) => e.profile).sort()).toEqual(profile.sort());

    const exports = (
      JSON.parse(readFileSync(join(ROOT, 'packages/config/package.json'), 'utf8')) as {
        exports: Record<string, string>;
      }
    ).exports;
    for (const { file, profile: name } of liste) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(exports[`./profiles/${name}`]).toBe(`./src/profiles/${name}.ts`);
    }
  });

  it('lässt die Einstiege zu und meldet jede andere erste Anweisung', async () => {
    for (const { file, profile } of await einstiege()) {
      expect(await meldungen(file), file).toEqual([]);

      const profilImport = `import '@taxtronik/config/profiles/${profile}';`;
      const andererImport = "import { a } from 'node:fs';";
      expect(
        await meldungen(file, `// Kopf\n${profilImport}\n${andererImport}\nexport const b = a;\n`),
      ).toEqual([]);

      const erwartet = [
        `1: Erster Import muss '@taxtronik/config/profiles/${profile}' sein: das ENV-Profil wirkt nur vor jeder Auswertung von @taxtronik/config (K-09).`,
      ];
      expect(
        await meldungen(file, `${andererImport}\n${profilImport}\nexport const b = a;\n`),
      ).toEqual(erwartet);
      expect(await meldungen(file, `export const b = 1;\n${profilImport}\n`)).toEqual(erwartet);
      const fremd = profile === 'worker' ? 'cli-storage' : 'worker';
      expect(
        await meldungen(
          file,
          `import '@taxtronik/config/profiles/${fremd}';\nexport const b = 1;\n`,
        ),
      ).toEqual(erwartet);
    }
  });
});
