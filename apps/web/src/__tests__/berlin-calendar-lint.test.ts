import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const eslint = new ESLint({ cwd: root });
const ruleId = 'calendar/no-utc-today-in-form';

async function violations(source: string, file = 'apps/web/src/components/new-calendar-form.tsx') {
  const [result] = await eslint.lintText(source, { filePath: join(root, file) });
  expect(result!.fatalErrorCount).toBe(0);
  return result!.messages
    .filter((message) => message.ruleId === ruleId)
    .map((message) => message.line);
}

describe('ESLint meldet den UTC-Tag der Systemuhr in Kalendervorgaben', () => {
  it('erkennt die ursprünglichen Fehler in neuen Komponenten und Routen', async () => {
    const source = [
      'export function Form() {',
      '  const tomorrow = new Date();',
      '  tomorrow.setDate(tomorrow.getDate() + 1);',
      '  const due = tomorrow.toISOString().slice(0, 10);',
      '  const currentYear = new Date().getUTCFullYear();',
      '  return <><input type="date" defaultValue={due} min={new Date().toISOString().slice(0, 10)} />',
      '    <PlanWizard defaultYear={currentYear + 1} /></>;',
      '}',
    ].join('\n');
    for (const file of [
      'apps/web/src/components/new-calendar-form.tsx',
      'apps/web/src/app/staff/(protected)/new-module/page.tsx',
      'apps/web/src/app/portal/(protected)/new-module/page.tsx',
    ])
      await expect(violations(source, file)).resolves.toEqual([6, 6, 7]);
  });

  it('verfolgt Unixzeit, ISO-Text und den Datumswert über lokale Namen', async () => {
    const source = [
      'export function Form() {',
      '  const stamp = Date.now();',
      '  const instant = new Date(stamp + 86400000);',
      '  const iso = instant.toISOString();',
      "  const day = iso.split('T')[0];",
      '  return <><input type="date" max={day} />',
      '    <input type="month" value={iso.substring(0, 7)} />',
      '    <DatePicker initialValidFrom={iso.slice(0, 10)} /></>;',
      '}',
    ].join('\n');
    await expect(violations(source)).resolves.toEqual([6, 7, 8]);
  });

  it('erkennt Fallback und Vorbelegung kontrollierter React-Datumsfelder', async () => {
    const source = [
      'export function Form({stored}: {stored?: Date}) {',
      '  const [due] = useState(() => new Date(Date.now()).toISOString().slice(0, 10));',
      '  const [year] = React.useState(new Date().getUTCFullYear());',
      '  const fallback = new Date().toISOString().slice(0, 10);',
      '  return <><input type="date" value={due} />',
      '    <select value={year} />',
      '    <input type="date" defaultValue={stored?.toISOString().slice(0, 10) ?? fallback} /></>;',
      '}',
    ].join('\n');
    await expect(violations(source)).resolves.toEqual([5, 6, 7]);
  });

  it('unterscheidet heutige Uhrzeit, gespeicherte DATE-Werte und technische Zeitstempel', async () => {
    const source = [
      'export function Form({stored, raw}: {stored: Date, raw: string}) {',
      '  const now = new Date();',
      '  const berlinToday = berlinTodayUtcMidnight(now);',
      '  const stamp = now.toISOString();',
      '  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));',
      '  return <><input type="date" defaultValue={stored.toISOString().slice(0, 10)} />',
      '    <input type="date" min={berlinYmd(now)} max={new Date(raw).toISOString().slice(0, 10)} />',
      '    <input type="date" value={berlinToday.toISOString().slice(0, 10)} />',
      '    <PlanWizard defaultYear={berlinToday.getUTCFullYear() + 1} />',
      '    <input type="hidden" name="expiresAt" value={midnight.toISOString()} />',
      '    <time dateTime={stamp}>{stamp}</time><a download={stamp.slice(0, 10)} />',
      '    <input type="text" defaultValue={stamp} /></>;',
      '}',
    ].join('\n');
    await expect(violations(source)).resolves.toEqual([]);
  });

  it('respektiert überschattete Namen und neu zugewiesene Werte', async () => {
    await expect(
      violations(`
      const current = new Date();
      function Form({current}: {current: Date}) {
        let picked = new Date();
        picked = current;
        return <input type="date" value={picked.toISOString().slice(0, 10)} min={current.toISOString().slice(0, 10)} />;
      }
      function ImportedDate({Date}: {Date: DateConstructor}) {
        return <PlanWizard defaultYear={new Date().getUTCFullYear()} />;
      }`),
    ).resolves.toEqual([]);
  });
});
