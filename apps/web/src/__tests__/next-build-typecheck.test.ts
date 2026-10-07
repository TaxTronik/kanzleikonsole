// =============================================================================
// Typprüfung im `next build` nur, wo CI denselben Stand schon geprüft hat
// (Review-Befund B-07).
//
// `next build` prüft die Typen, außer TAXTRONIK_SKIP_BUILD_TYPECHECK=1 ist
// gesetzt. Das ist nur sicher, wenn derselbe Code vorher dasselbe TypeScript-
// Programm durchlaufen hat. Geprüft wird deshalb:
//   1. Der Schalter wirkt genau über next.config.mjs.
//   2. `pnpm typecheck` prüft dasselbe Programm wie `next build`: dieselben
//      Wurzeldateien und dieselben Optionen, die Next erzwingt (Next-Interna,
//      die beim Next-Upgrade bewusst mitgeprüft werden).
//   3. Nur der E2E-Build in ci.yml setzt den Schalter, und sein Job hängt an
//      quality, das `pnpm typecheck` bedingungslos ausführt.
// =============================================================================

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Step = { name?: string; run?: string; env?: Record<string, string>; if?: string };
type Job = {
  needs?: string | string[];
  env?: Record<string, string>;
  if?: string;
  'continue-on-error'?: boolean;
  steps: Step[];
};
type Workflow = { env?: Record<string, string>; jobs: Record<string, Job> };

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WEB = join(ROOT, 'apps/web');
const SWITCH = 'TAXTRONIK_SKIP_BUILD_TYPECHECK';
const requireFromWeb = createRequire(join(WEB, 'package.json'));
const yaml = requireFromWeb('js-yaml') as { load: (source: string) => Workflow };
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const workflow = (file: string) => yaml.load(read(`.forgejo/workflows/${file}`));

async function ignoreBuildErrors(value: string | undefined): Promise<boolean> {
  vi.resetModules();
  vi.stubEnv(SWITCH, value);
  const config = (await import('../../next.config.mjs')).default as {
    typescript?: { ignoreBuildErrors?: boolean };
  };
  return config.typescript?.ignoreBuildErrors === true;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Typprüfung im next build', () => {
  it('überspringt sie nur mit dem ausdrücklichen Schalter', async () => {
    expect(await ignoreBuildErrors(undefined)).toBe(false);
    expect(await ignoreBuildErrors('0')).toBe(false);
    expect(await ignoreBuildErrors('true')).toBe(false);
    expect(await ignoreBuildErrors('1')).toBe(true);
  });

  it('pnpm typecheck prüft dasselbe TypeScript-Programm wie next build', async () => {
    const ts = requireFromWeb('typescript') as typeof import('typescript');
    const tsconfig = join(WEB, 'tsconfig.json');
    const { getTypeScriptConfiguration } = requireFromWeb(
      'next/dist/lib/typescript/getTypeScriptConfiguration',
    ) as {
      getTypeScriptConfiguration: (
        typescript: typeof ts,
        path: string,
      ) => Promise<{ fileNames: string[] }>;
    };
    const { getRequiredConfiguration } = requireFromWeb(
      'next/dist/lib/typescript/writeConfigurationDefaults',
    ) as { getRequiredConfiguration: (typescript: typeof ts) => Record<string, unknown> };
    const { getDevTypesPath } = requireFromWeb('next/dist/lib/typescript/type-paths') as {
      getDevTypesPath: (baseDir: string, distDir: string) => string | null;
    };

    // tsc: `tsc --noEmit` im Paket (apps/web/package.json, Skript typecheck).
    const parsed = ts.getParsedCommandLineOfConfigFile(
      tsconfig,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      },
    )!;
    // next build (runTypeCheck): Dateien der tsconfig ohne .next/dev/types …
    const devTypes = getDevTypesPath(WEB, '.next');
    const nextFiles = (await getTypeScriptConfiguration(ts, tsconfig)).fileNames.filter(
      (file) => !devTypes || !file.startsWith(devTypes),
    );
    expect([...nextFiles].sort()).toEqual([...parsed.fileNames].sort());
    // … und die tsconfig-Optionen, überschrieben mit den von Next verlangten.
    for (const [option, value] of Object.entries(getRequiredConfiguration(ts))) {
      expect(parsed.options[option], option).toEqual(value);
    }

    // Die erzeugten Routentypen bindet next-env.d.ts ein; typegen erzeugt sie
    // vor tsc, wie der Build vor seiner Prüfung.
    const scripts = (
      JSON.parse(read('apps/web/package.json')) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts['typecheck']).toBe('next typegen && tsc --noEmit');
    expect(read('apps/web/next-env.d.ts')).toContain('import "./.next/types/routes.d.ts";');
    const rootScripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    expect(rootScripts['typecheck']).toMatch(/^turbo run typecheck(?: |$)/);
    expect(rootScripts['typecheck']).not.toContain('--filter');
  });

  it('nur der E2E-Build nach dem Typecheck im Job quality setzt den Schalter', () => {
    const ci = workflow('ci.yml');
    const setters = Object.entries(ci.jobs).flatMap(([job, definition]) => [
      ...(definition.env?.[SWITCH] !== undefined ? [`${job} (Job)`] : []),
      ...definition.steps
        .filter((step) => step.env?.[SWITCH] !== undefined)
        .map((step) => `${job}: ${step.run?.trim()}`),
    ]);
    expect(ci.env?.[SWITCH]).toBeUndefined();
    expect(setters).toEqual(['e2e-paranoid: pnpm --filter @taxtronik/web build']);
    const build = ci.jobs['e2e-paranoid']!.steps.find(
      (step) => step.run?.trim() === 'pnpm --filter @taxtronik/web build',
    )!;
    expect(build.env?.[SWITCH]).toBe('1');

    const needs = ci.jobs['e2e-paranoid']!.needs;
    expect(Array.isArray(needs) ? needs : [needs]).toContain('quality');
    const quality = ci.jobs['quality']!;
    expect(quality.if).toBeUndefined();
    expect(quality['continue-on-error']).toBeFalsy();
    const typecheck = quality.steps.filter((step) => step.run?.trim() === 'pnpm typecheck');
    expect(typecheck).toHaveLength(1);
    expect(typecheck[0]!.if).toBeUndefined();

    for (const file of ['release.yml', 'build-images.yml', 'security.yml', 'renovate.yml']) {
      expect(read(`.forgejo/workflows/${file}`), file).not.toContain(SWITCH);
    }
    // Images (auch Quell-Builds beim Betreiber) prüfen weiter selbst.
    expect(read('infra/docker/Dockerfile.web')).not.toContain(SWITCH);
  });
});
