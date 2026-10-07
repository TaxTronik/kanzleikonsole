// =============================================================================
// Typisierte Worker-ENV (Review-Befund K-09).
//
// Worker-Module lesen `env` über ../env: derselbe validierte Wert wie aus
// @taxtronik/config, aber mit dem Typ des Profils „worker“. Felder anderer
// Prozesse lehnt damit schon tsc ab (die @ts-expect-error-Zeilen und
// expectTypeOf prüft der Typecheck des Workers), nicht erst der Laufzeitschutz
// in packages/config/src/env.ts. Die ESLint-Regel hält Worker-Module auf ../env.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '@taxtronik/config';
import { ESLint } from 'eslint';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: { NODE_ENV: 'test', REDIS_URL: 'redis://worker.test:6379' },
}));
vi.mock('@taxtronik/config', () => ({ env: h.env }));

import { env, type WorkerEnv } from '../env';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
// Wie packages/config/src/__tests__/env-profile-entries.test.ts: das Laden der
// vollen Lint-Konfiguration braucht unter CI-Last mehr als 5 s.
const LINT_TIMEOUT_MS = 60_000;

describe('Worker-ENV mit dem Typ des Profils „worker“', () => {
  it('ist die validierte ENV aus @taxtronik/config', () => {
    expect(env).toBe(h.env);
    expect(env.REDIS_URL).toBe('redis://worker.test:6379');
  });

  it('typisiert Worker-Felder und lehnt Felder anderer Prozesse ab', () => {
    expectTypeOf(env).toEqualTypeOf<WorkerEnv>();
    expectTypeOf(env.REDIS_URL).toEqualTypeOf<string>();
    expectTypeOf(env.S3_BUCKET_GOBD).toEqualTypeOf<string>();
    expectTypeOf(env.SMTP_PORT).toEqualTypeOf<number>();
    expectTypeOf(env.TIMESTAMP_AUTHORITY_URL).toEqualTypeOf<string | undefined>();
    // Im Worker nur optionaler Fallback der Link-Basis, im Web Pflicht.
    expectTypeOf(env.NEXTAUTH_URL).toEqualTypeOf<string | undefined>();
    expectTypeOf<Env['NEXTAUTH_URL']>().toEqualTypeOf<string>();

    const fremdeFelder = (worker: WorkerEnv) => [
      // @ts-expect-error Web-Auth gehört nur zum Web-Profil.
      worker.NEXTAUTH_TRUST_HOST,
      // @ts-expect-error Web-Auth gehört nur zum Web-Profil.
      worker.TRUST_PROXY_REQUIRED,
      // @ts-expect-error Web-Auth gehört nur zum Web-Profil.
      worker.DEV_SKIP_TOTP,
      // @ts-expect-error ELSTER gehört nur zum Web-Profil.
      worker.ELSTER_BRIDGE_URL,
      // @ts-expect-error Lizenz gehört nur zum Web-Profil.
      worker.LICENSE_KEY,
    ];
    expect(fremdeFelder).toBeTypeOf('function');
  });
});

describe('ESLint hält Worker-Module auf ../env', { timeout: LINT_TIMEOUT_MS }, () => {
  const eslint = new ESLint({ cwd: ROOT });

  async function meldungen(file: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) });
    return result!.messages
      .filter((message) => message.ruleId === 'no-restricted-imports')
      .map((message) => message.message);
  }

  it('meldet `env` aus @taxtronik/config in Worker-Modulen', async () => {
    const nutzung = 'export const url = env.REDIS_URL;\n';
    for (const file of ['apps/worker/src/queues.ts', 'apps/worker/src/jobs/audit-anchor.ts']) {
      for (const quelle of ['@taxtronik/config', '@taxtronik/config/env']) {
        expect(await meldungen(file, `import { env } from '${quelle}';\n${nutzung}`)).toEqual([
          expect.stringContaining('apps/worker/src/env.ts (Typ WorkerEnv'),
        ]);
      }
    }
  });

  it('lässt ../env, andere Exporte von @taxtronik/config und das env-Modul selbst zu', async () => {
    expect(
      await meldungen(
        'apps/worker/src/queues.ts',
        "import { env } from './env';\nexport const url = env.REDIS_URL;\n",
      ),
    ).toEqual([]);
    expect(
      await meldungen(
        'apps/worker/src/jobs/n8n-deliver.ts',
        "import { n8nDeliveryMode } from '@taxtronik/config';\nexport const mode = n8nDeliveryMode;\n",
      ),
    ).toEqual([]);
    const envModule = 'apps/worker/src/env.ts';
    expect(await meldungen(envModule, readFileSync(join(ROOT, envModule), 'utf8'))).toEqual([]);
  });
});
