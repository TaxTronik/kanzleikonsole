import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');
const webRoot = dirname(webRequire.resolve('./package.json'));
let source: Promise<string> | undefined;

async function mountClientForms(page: Page, binders: Record<string, unknown>[] = []) {
  source ??= build({
    stdin: {
      contents: `
        import {createRoot} from 'react-dom/client';
        import {PauseWorkflowButton} from './src/app/staff/(protected)/clients/[id]/workflows/pause-restore-buttons';
        import {BindersBlock} from './src/app/staff/(protected)/clients/[id]/binders/binders-block';
        createRoot(document.getElementById('root')).render(<main>
          <PauseWorkflowButton instanceId="auftrag" instanceName="Monatsabschluss" />
          <BindersBlock clientId="mandat" initial={globalThis.__binders} />
        </main>);`,
      loader: 'tsx',
      resolveDir: webRoot,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [
      {
        name: 'client-operational-dates',
        setup(builder) {
          builder.onResolve({ filter: /^(?:next\/navigation|\.\/actions)$/ }, ({ path }) => ({
            path,
            namespace: 'test-boundary',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, ({ path }) => ({
            contents:
              path === 'next/navigation'
                ? 'export const useRouter = () => ({refresh(){}});'
                : `
              export async function pauseInstanceAction(input) { globalThis.__submissions.push(input.until); return {ok:true}; }
              export async function createBinderAction(_, form) { globalThis.__submissions.push(form.get('expectedReturnAt')); return {ok:true}; }
              export const resumeInstanceAction = undefined, restoreInstanceAction = undefined,
                deleteBinderAction = undefined, updateBinderStatusAction = undefined;`,
          }));
        },
      },
    ],
  }).then((result) => result.outputFiles[0]!.text);
  await page.setContent('<div id="root"></div>');
  await page.evaluate((rows) => {
    Object.assign(window, { __binders: rows, __submissions: [] });
  }, binders);
  await page.addScriptTag({ content: await source });
  await expect(page.getByRole('main')).toBeVisible();
}

function submissions(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __submissions: (string | null)[] }).__submissions,
  );
}

test.use({ timezoneId: 'America/Los_Angeles' });

test('WORKFLOW-LIFECYCLE-001 – Wiederaufnahmetag beim Öffnen, bei Übernahme und ohne Termin', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-07-01T21:59:59Z'));
  await mountClientForms(page);
  await page.clock.setFixedTime(new Date('2026-07-01T22:30:00Z'));
  const open = page.getByRole('button', { name: 'Pausieren', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog');
  const until = dialog.getByLabel('Wiederaufnahme am (optional)');
  await expect(until).toHaveValue('');
  await expect(until).toHaveAttribute('min', '2026-07-02');
  await until.fill('2026-07-01');
  await dialog.getByRole('button', { name: 'Pausieren' }).click();
  expect(await submissions(page)).toEqual([]);
  await expect(until).toBeFocused();
  await until.fill('2026-07-02');
  await dialog.getByRole('button', { name: 'Pausieren' }).click();
  await expect.poll(() => submissions(page)).toEqual(['2026-07-02']);
  await open.click();
  await dialog.getByRole('button', { name: 'Pausieren' }).click();
  await expect.poll(() => submissions(page)).toEqual(['2026-07-02', null]);
});

test('TAX-CONTROL-STATUS-001 – Rückgabetag beim Öffnen und bei Übergabe des Pendelordners', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-11-19T22:59:59Z'));
  await mountClientForms(page);
  await page.clock.setFixedTime(new Date('2026-11-19T23:30:00Z'));
  await page.getByRole('button', { name: 'Neu' }).click();
  const due = page.getByTitle('Erwartete Rückgabe');
  await expect(due).toHaveValue('');
  await expect(due).toHaveAttribute('min', '2026-11-20');
  const label = page.getByPlaceholder(/^Bezeichnung/);
  await label.fill('Novemberordner');
  await due.fill('2026-11-19');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  expect(await submissions(page)).toEqual([]);
  await expect(due).toBeFocused();
  await due.fill('2026-11-20');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect.poll(() => submissions(page)).toEqual(['2026-11-20']);
  await expect(label).toHaveValue('');
  await expect(due).toHaveValue('');
  await label.fill('Ohne Rückgabetag');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect.poll(() => submissions(page)).toEqual(['2026-11-20', '']);
});

test('TAX-CONTROL-STATUS-001 – Nur ausgegebene Pendelordner mit vergangenem Berliner Rückgabetag sind überfällig', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-11-20T08:30:00Z'));
  const cases = [
    ['Vortag', 'WITH_CLIENT', '2026-11-19', true],
    ['Heute', 'WITH_CLIENT', '2026-11-20', false],
    ['Morgen', 'WITH_CLIENT', '2026-11-21', false],
    ['Vorbereitet', 'PREPARED', '2026-11-19', false],
    ['Zurückerhalten', 'RETURNED', '2026-11-19', false],
    ['Undatiert', 'WITH_CLIENT', null, false],
  ] as const;
  await mountClientForms(
    page,
    cases.map(([label, status, date]) => ({
      id: label,
      label: 'Ordner ' + label,
      status,
      expectedReturnAt: date ? date + 'T00:00:00Z' : null,
      contents: null,
      sentAt: null,
      returnedAt: null,
    })),
  );
  for (const [label, , , overdue] of cases) {
    const row = page.getByRole('listitem').filter({ hasText: 'Ordner ' + label });
    await expect(row).toBeVisible();
    await expect(row.getByText('überfällig')).toHaveCount(overdue ? 1 : 0);
  }
});
