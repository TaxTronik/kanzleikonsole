import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../../../web/', import.meta.url));
type FormKind = 'calendar' | 'portal' | 'request';
type Submission = { action: FormKind; fields: Record<string, string> };

function buildForms() {
  return build({
    stdin: {
      resolveDir: webRoot,
      loader: 'tsx',
      contents: `
        import {createRoot} from 'react-dom/client';
        import {NewAppointmentDialog} from './src/app/staff/(protected)/calendar/new-appointment-dialog';
        import {AppointmentRequestForm} from './src/app/portal/(protected)/appointments/request-form';
        import {NewRequestForm} from './src/components/requests/new-request-form';
        const {kind, days} = window.formFixture;
        const staff = [{id:'sachbearbeiter', fullName:'Eva Beispiel'}];
        const submit = async (_, data) => {
          await window.captureForm({action:'request', fields:Object.fromEntries(data)});
          return {ok:true};
        };
        const template = {id:'vorlage', name:'Unterlagen', title:'Belege einreichen',
          description:'Bitte die Belege einreichen.', category:null, priority:'NORMAL',
          formTemplateId:null, dueAfterDays:days};
        const forms = {
          calendar:<NewAppointmentDialog staffOptions={staff} currentStaffId="sachbearbeiter"/>,
          portal:<AppointmentRequestForm staffOptions={staff}/>,
          request:<NewRequestForm action={submit} clientId="mandant" requestId="anforderung"
            templates={[template]} formTemplates={[]}/>
        };
        createRoot(document.getElementById('root')).render(forms[kind]);`,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    jsx: 'automatic',
    outdir: 'fixture',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'calendar-form-actions',
        setup(builder) {
          builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: 'router',
            namespace: 'fixture',
          }));
          builder.onResolve({ filter: /^\.\/actions$/ }, ({ importer }) => {
            if (/[\\/](calendar|appointments)[\\/]/.test(importer)) {
              return { path: 'appointments', namespace: 'fixture' };
            }
          });
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            contents:
              path === 'router'
                ? 'export const useRouter = () => ({refresh(){}});'
                : `async function capture(action, data) {
                 await window.captureForm({action, fields:Object.fromEntries(data)});
                 return {ok:true};
               }
               export const createAppointmentAction = (_, data) => capture('calendar', data);
               export const createAppointmentRequestAction = (_, data) => capture('portal', data);`,
          }));
        },
      },
    ],
  });
}

let bundle: ReturnType<typeof buildForms> | undefined;

async function openForm(page: Page, kind: FormKind, now: string, days = 1) {
  await page.clock.setFixedTime(new Date(now));
  const submissions: Submission[] = [];
  await page.exposeFunction('captureForm', (entry: Submission) => {
    submissions.push(entry);
  });
  await page.setContent(
    '<meta name="viewport" content="width=device-width, initial-scale=1"><main id="root"></main>',
  );
  await page.evaluate((fixture) => Object.assign(window, { formFixture: fixture }), { kind, days });
  bundle ??= buildForms();
  const { outputFiles } = await bundle;
  await page.addStyleTag({ content: outputFiles.find((file) => file.path.endsWith('.css'))!.text });
  await page.addScriptTag({ content: outputFiles.find((file) => file.path.endsWith('.js'))!.text });
  return submissions;
}

test.describe('Berliner Formularvorbelegungen', () => {
  for (const [label, now, start, endTime] of [
    ['Berliner Tageswechsel', '2026-07-01T22:30:00Z', '2026-07-02T00:30', '2026-07-02T01:00'],
    ['Umstellungstag in den USA', '2026-03-08T01:30:00Z', '2026-03-08T02:30', '2026-03-08T03:00'],
  ] as const) {
    test(`APPT-BERLIN-WALLCLOCK-001 – Kanzleitermin am ${label}`, async ({ page }) => {
      const submissions = await openForm(page, 'calendar', now);
      await page.getByRole('button', { name: 'Neuer Termin' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Start', { exact: true })).toHaveValue(start);
      const end = dialog.getByLabel('Ende', { exact: true });
      await expect(end).toHaveValue('');
      await dialog.getByLabel('Titel', { exact: true }).fill('Vierteljahresbesprechung');
      await end.fill(endTime);
      await dialog.getByRole('button', { name: 'Anlegen' }).click();
      await expect
        .poll(() => submissions)
        .toEqual([
          {
            action: 'calendar',
            fields: expect.objectContaining({
              startsAt: start,
              endsAt: endTime,
            }),
          },
        ]);
    });
  }

  test('APPT-BERLIN-WALLCLOCK-001 – Portal schlägt Berliner Folgetage ab 10 Uhr vor und sperrt gestern', async ({
    page,
  }) => {
    const submissions = await openForm(page, 'portal', '2026-07-01T22:30:00Z');
    await page.getByRole('button', { name: 'Anfragen' }).click();
    const starts = page.getByLabel('Beginn', { exact: true });
    const ends = page.getByLabel('Ende', { exact: true });
    await expect(starts).toHaveValue('03.07.2026 10:00');
    await expect(ends).toHaveValue('03.07.2026 11:00');
    await starts.click();
    const calendar = page.locator('.react-datepicker');
    await expect(
      calendar.locator('.react-datepicker__day--001:not(.react-datepicker__day--outside-month)'),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(
      calendar.locator('.react-datepicker__day--002:not(.react-datepicker__day--outside-month)'),
    ).toHaveAttribute('aria-disabled', 'false');
    await starts.press('Escape');
    await page.getByRole('button', { name: 'Weiteren Wunschtermin hinzufügen' }).click();
    await expect(starts.nth(1)).toHaveValue('04.07.2026 10:00');
    await expect(ends.nth(1)).toHaveValue('04.07.2026 11:00');
    await page.getByLabel('Anliegen / Betreff').fill('Jahresplanung');
    await page.getByRole('button', { name: 'Anfrage senden' }).click();
    await expect
      .poll(() => submissions)
      .toEqual([
        {
          action: 'portal',
          fields: expect.objectContaining({
            slot0_starts: '2026-07-03T10:00',
            slot0_ends: '2026-07-03T11:00',
            slot1_starts: '2026-07-04T10:00',
            slot1_ends: '2026-07-04T11:00',
          }),
        },
      ]);
  });

  for (const [label, now, days, expected, display] of [
    ['Berliner Tagesgrenze', '2026-07-01T22:30:00Z', 1, '2026-07-03T00:30', '03.07.2026 00:30'],
    [
      'amerikanische Frühjahrslücke',
      '2026-03-07T01:30:00Z',
      1,
      '2026-03-08T02:30',
      '08.03.2026 02:30',
    ],
    ['Berliner Frühjahrslücke', '2026-03-28T01:30:00Z', 1, '2026-03-29T03:30', '29.03.2026 03:30'],
    [
      'Kalendertage über die Berliner Umstellung',
      '2026-03-28T22:30:00Z',
      2,
      '2026-03-30T23:30',
      '30.03.2026 23:30',
    ],
  ] as const) {
    test(`REQ-LIFECYCLE-001 – Zieltermin der Vorlage · ${label}`, async ({ page }) => {
      const submissions = await openForm(page, 'request', now, days);
      const due = page.getByLabel('Fällig am', { exact: true });
      await expect(due).toHaveValue('');
      await page.getByLabel('Vorlage anwenden').selectOption('vorlage');
      // In einer Lücke der Browserzeitzone erhält datetime-local die gültige Berliner Wanduhr.
      const native = (await due.getAttribute('type')) === 'datetime-local';
      await expect(due).toHaveValue(native ? expected : display);
      await page.getByRole('button', { name: 'Anforderung erstellen' }).click();
      await expect
        .poll(() => submissions)
        .toEqual([
          {
            action: 'request',
            fields: expect.objectContaining({
              dueAt: expected,
              templateId: 'vorlage',
            }),
          },
        ]);
    });
  }
});
