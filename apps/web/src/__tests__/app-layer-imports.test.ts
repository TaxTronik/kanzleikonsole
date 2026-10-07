// =============================================================================
// Schichtgrenze components/ und server/ → app/ und Oberflächengrenze
// Staff → Portal (Review-Befund K-08).
//
// Prüft die ESLint-Regeln aus eslint.config.mjs mit der echten Konfiguration:
// statische, Typ-, Re-Export-, relative und dynamische Importe aus app/ sind
// in components/ und server/ Fehler, Importe aus app/portal in Staff-Seiten;
// Tests bleiben frei. Ausnahmen gelten nur für die genannten Module der
// genannten Datei und dürfen nicht veralten.
// =============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { APP_LAYER_ALLOWLIST, STAFF_PORTAL_ALLOWLIST } from '../../../../eslint.config.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

async function verstoesse(file: string, code: string): Promise<number[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return result!.messages
    .filter((m) =>
      ['no-restricted-imports', 'no-restricted-syntax', 'surface/no-portal-import'].includes(
        m.ruleId ?? '',
      ),
    )
    .map((m) => m.line);
}

const VERBOTEN = [
  "import { a } from '@/app/staff/(protected)/documents/actions';",
  "import type { B } from '@/app/portal/(protected)/bwa/plan/plan-comparison';",
  "export { c } from '@/app/staff/(protected)/x';",
  "import { d } from '../app/staff/(protected)/y';",
  "export const e = () => import('@/app/staff/(protected)/z');",
].join('\n');

describe('Schichtgrenze components/ und server/ → app/', () => {
  it('meldet jeden Importweg aus app/ in components/ und server/', async () => {
    await expect(verstoesse('apps/web/src/components/k08-probe.tsx', VERBOTEN)).resolves.toEqual([
      1, 2, 3, 4, 5,
    ]);
    await expect(
      verstoesse(
        'apps/web/src/server/k08/probe.ts',
        "import { a } from '../../app/staff/(protected)/z';\nexport const b = a;",
      ),
    ).resolves.toEqual([1]);
  });

  it('lässt Routen, Tests und Importe außerhalb von app/ zu', async () => {
    await expect(
      verstoesse('apps/web/src/app/portal/(protected)/k08/page.tsx', VERBOTEN),
    ).resolves.toEqual([]);
    // Staff-Routen dürfen aus app/ importieren, nur nicht aus app/portal (Zeile 2).
    await expect(
      verstoesse('apps/web/src/app/staff/(protected)/k08/page.tsx', VERBOTEN),
    ).resolves.toEqual([2]);
    await expect(
      verstoesse('apps/web/src/components/__tests__/k08.test.tsx', VERBOTEN),
    ).resolves.toEqual([]);
    await expect(
      verstoesse(
        'apps/web/src/components/k08-probe.tsx',
        "import { Modal } from '@/components/ui/modal';\nexport const m = () => import('@/server/k08');\nexport { Modal };",
      ),
    ).resolves.toEqual([]);
  });

  it('erlaubt in Ausnahmedateien nur die genannten Module', async () => {
    const [eintrag] = APP_LAYER_ALLOWLIST;
    const modul = `@/app/${eintrag!.modules[0]}`;
    await expect(
      verstoesse(
        eintrag!.files[0]!,
        [
          `import type { T } from '${modul}';`,
          `export const lade = () => import('${modul}');`,
          "import { x } from '@/app/staff/(protected)/requests/page';",
          "export const y = () => import('@/app/staff/(protected)/requests/page');",
          `import { z } from '${modul}-x';`,
          'export type { T };',
        ].join('\n'),
      ),
    ).resolves.toEqual([3, 4, 5]);
  });

  it('meldet in Staff-Seiten jeden Importweg nach app/portal', async () => {
    const portal = [
      "import { a } from '@/app/portal/(protected)/bwa/plan/plan-wizard';",
      "import type { B } from '../../../../portal/(protected)/inbox/page';",
      "export { c } from '@/app/portal/(protected)/x';",
      "export * from '../../../../portal/y';",
      "export const d = () => import('@/app/portal/(protected)/z');",
      // Ein Staff-Ordner namens portal ist kein Portal-Modul.
      "import { e } from '../portal/page';",
      "import { f } from '@/components/bwa/plan-editor';",
      'export { a, e, f };',
      'export type { B };',
    ].join('\n');
    await expect(
      verstoesse('apps/web/src/app/staff/(protected)/admin/settings/k08-probe.tsx', portal),
    ).resolves.toEqual([1, 2, 3, 4, 5]);
    await expect(
      verstoesse(
        'apps/web/src/app/staff/(protected)/admin/settings/__tests__/k08.test.tsx',
        portal,
      ),
    ).resolves.toEqual([]);
    // K-08: keine Ausnahme mehr; die frühere Ausnahmedatei (neue Planung)
    // bezieht den Plan-Assistenten aus components/bwa und hält die Regel ein.
    expect(STAFF_PORTAL_ALLOWLIST).toEqual([]);
    const newPlanPage = 'apps/web/src/app/staff/(protected)/clients/[id]/bwa/plans/new/page.tsx';
    await expect(
      verstoesse(newPlanPage, readFileSync(join(ROOT, newPlanPage), 'utf8')),
    ).resolves.toEqual([]);
    await expect(
      verstoesse(
        newPlanPage,
        "import { PlanWizard } from '@/app/portal/(protected)/bwa/plan/plan-wizard';\nexport { PlanWizard };",
      ),
    ).resolves.toEqual([1]);
  });

  it('hält katalog-gepinnte UI nicht mehr per Ausnahme in app/ und server/ (K-08)', async () => {
    // Früher per Ausnahme erlaubt, weil der Fachkatalog den Pfad festhielt; die
    // Dateien liegen jetzt unter components/ und die Ausnahmen sind entfernt.
    const ausnahmen = [...APP_LAYER_ALLOWLIST, ...STAFF_PORTAL_ALLOWLIST].flatMap((e) => e.files);
    for (const file of [
      'apps/web/src/components/quick-request-dialog.tsx',
      'apps/web/src/components/bwa/bwa-dashboard.tsx',
      'apps/web/src/app/staff/(protected)/clients/[id]/bwa/plans/new/page.tsx',
    ]) {
      expect(ausnahmen).not.toContain(file);
      await expect(verstoesse(file, readFileSync(join(ROOT, file), 'utf8'))).resolves.toEqual([]);
    }
    // In server/ liegt keine Oberfläche mehr (.tsx außerhalb von Tests).
    const ui = readdirSync(join(ROOT, 'apps/web/src/server'), {
      recursive: true,
      encoding: 'utf8',
    }).filter((file) => file.endsWith('.tsx') && !file.split(sep).includes('__tests__'));
    expect(ui).toEqual([]);
  });

  it('führt keine veralteten Ausnahmen', () => {
    for (const { files, modules } of [...APP_LAYER_ALLOWLIST, ...STAFF_PORTAL_ALLOWLIST]) {
      const quellen = files.map((file) => readFileSync(join(ROOT, file), 'utf8'));
      for (const modul of modules) {
        // Jedes erlaubte Modul wird von mindestens einer Datei des Eintrags genutzt …
        expect(
          quellen.some((quelle) => quelle.includes(`'@/app/${modul}'`)),
          `${modul} in ${files.join(', ')}`,
        ).toBe(true);
      }
      // … und jede Datei nutzt mindestens eines der Module.
      for (const [index, quelle] of quellen.entries()) {
        expect(
          modules.some((modul) => quelle.includes(`'@/app/${modul}'`)),
          files[index],
        ).toBe(true);
      }
    }
  });
});
