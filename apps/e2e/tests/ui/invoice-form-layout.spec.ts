// INV-NUMBER-ALLOCATION-001: bearbeitbare Felder der manuellen und externen Rechnungsanlage.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { chooseClient } from '../helpers/client-combobox';
import { addWebStyles } from '../helpers/web-styles';

const webRoot = fileURLToPath(new URL('../../../web/', import.meta.url));
const origin = 'https://invoice.test';
const client = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Beispielmandat',
  datevNo: null,
  addisonNo: null,
  allowActive: true,
  mandateEnded: false,
};
let forms: Promise<string> | undefined;

function invoiceForms() {
  forms ??= build({
    stdin: {
      contents: `
        import {createRoot} from 'react-dom/client';
        import {NewInvoiceForm} from './src/app/staff/(protected)/invoices/new/form';
        import {ExternalInvoiceForm} from './src/app/staff/(protected)/invoices/new/external-form';
        const external = location.pathname === '/external';
        const dates = {initialIssueDate: '2026-07-01', initialDueDate: external ? '2026-07-15' : '2026-07-31'};
        createRoot(document.querySelector('main')).render(external
          ? <ExternalInvoiceForm categories={[]} {...dates}/>
          : <NewInvoiceForm {...dates}/>);`,
      loader: 'tsx',
      resolveDir: webRoot,
    },
    bundle: true,
    write: false,
    jsx: 'automatic',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'invoice-server-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^(?:next\/navigation|\.\.\/actions)$/ }, ({ path }) => ({
            path,
            namespace: 'invoice-boundary',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'invoice-boundary' }, ({ path }) => ({
            contents:
              path === 'next/navigation'
                ? 'export const useRouter = () => ({push: href => history.pushState({}, "", href)});'
                : `
                export async function createInvoiceAction(invoice) {
                  await window.recordInvoice(invoice);
                  return {invoiceId: 'entwurf'};
                }
                export async function uploadExternalInvoiceAction(invoice, body) {
                  const file = body.get('pdf');
                  await window.recordInvoice({...invoice, pdf: {name: file.name, size: file.size}});
                  return {ok: true, id: 'abgelegt'};
                }`,
          }));
        },
      },
    ],
  }).then((result) => result.outputFiles[0]!.text);
  return forms;
}

async function openForm(page: Page, mode: 'internal' | 'external') {
  const submissions: unknown[] = [];
  await page.exposeFunction('recordInvoice', (input: unknown) => {
    submissions.push(input);
  });
  await page.route(origin + '/api/staff/clients/search*', (route) =>
    route.fulfill({ json: { clients: [client], limited: false, mode: 'search' } }),
  );
  await page.route(origin + '/' + mode, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="de"><meta name="viewport" content="width=device-width, initial-scale=1"><main class="p-4 sm:p-6 lg:p-8 max-w-4xl"></main></html>',
    }),
  );
  await page.goto(origin + '/' + mode);
  await addWebStyles(page);
  await page.addScriptTag({ content: await invoiceForms() });
  await chooseClient(page, page.getByRole('combobox', { name: /Mandant/ }), client.name);
  return submissions;
}

async function fieldBox(field: Locator) {
  return field.evaluate((element) => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom };
  });
}

test.describe('Rechnungsanlage mit produktivem Formularlayout', () => {
  test('Positionsfelder bleiben lesbar und die bearbeiteten Werte werden übernommen', async ({
    page,
  }) => {
    const submissions = await openForm(page, 'internal');
    const description = page.getByLabel('Beschreibung', { exact: true });
    const quantity = page.getByLabel('Menge', { exact: true });
    const unit = page.getByLabel('Einheit', { exact: true });
    const price = page.getByLabel('Einzelpreis €');
    const rate = page.getByLabel('USt %', { exact: true });
    const visibleValueWidth = await rate.evaluate((element: HTMLSelectElement) => {
      const style = getComputedStyle(element);
      const canvas = document.createElement('canvas').getContext('2d')!;
      canvas.font = style.font;
      const text = Math.max(
        ...Array.from(element.options, (option) => canvas.measureText(option.text).width),
      );
      return {
        available:
          element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        required: text + 16, // Platz für das native Auswahlzeichen neben dem zweistelligen Satz.
      };
    });
    expect(
      visibleValueWidth.available,
      'USt-Wert muss neben dem Auswahlzeichen lesbar sein',
    ).toBeGreaterThanOrEqual(visibleValueWidth.required);
    if (page.viewportSize()!.width <= 390) {
      expect((await fieldBox(quantity)).top).toBeGreaterThanOrEqual(
        (await fieldBox(description)).bottom,
      );
    }

    await page.getByLabel('Betreff', { exact: true }).fill('Beratung im Juli');
    await description.fill('Beratungsstunde');
    await description.press('Tab');
    await expect(quantity).toBeFocused();
    await quantity.fill('2');
    await unit.fill('Stunden');
    await price.fill('80.50');
    await rate.selectOption('7');
    await page.getByRole('button', { name: 'Rechnung anlegen' }).click();
    await expect(page).toHaveURL(origin + '/staff/invoices/entwurf');
    expect(submissions).toMatchObject([
      {
        clientId: client.id,
        subject: 'Beratung im Juli',
        positions: [
          {
            description: 'Beratungsstunde',
            quantity: 2,
            unit: 'Stunden',
            unitPrice: 80.5,
            vatRate: 7,
          },
        ],
      },
    ]);
  });

  test('PDF-Rechnung lässt Nummer und beide Daten ohne Seitenüberlauf bearbeiten und absenden', async ({
    page,
  }) => {
    const submissions = await openForm(page, 'external');
    const number = page.getByLabel(/Rechnungsnummer/);
    const issue = page.getByLabel(/Rechnungsdatum/);
    const due = page.getByLabel(/Fällig/);
    const [numberBox, issueBox, dueBox] = await Promise.all([
      fieldBox(number),
      fieldBox(issue),
      fieldBox(due),
    ]);
    if (page.viewportSize()!.width <= 390) {
      expect(issueBox.top, 'Rechnungsdatum unter der Nummer').toBeGreaterThanOrEqual(
        numberBox.bottom,
      );
      expect(dueBox.top, 'Fälligkeit unter dem Rechnungsdatum').toBeGreaterThanOrEqual(
        issueBox.bottom,
      );
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await number.fill('EXT-2026-19');
    await number.press('Tab');
    await expect(issue).toBeFocused();
    await issue.fill('2026-07-03');
    await due.fill('2026-07-20');
    await page.getByLabel(/Betrag \(Brutto/).fill('37.90');
    await page.getByLabel(/USt-Satz/).selectOption('7');
    await page.getByLabel(/Betreff/).fill('Externe Abrechnung');
    const pdf = Buffer.from('%PDF-1.4\n%%EOF');
    await page
      .getByLabel(/PDF-Datei/)
      .setInputFiles({ name: 'beleg.pdf', mimeType: 'application/pdf', buffer: pdf });
    await page.getByRole('button', { name: /Rechnung speichern/ }).click();
    await expect(page).toHaveURL(origin + '/staff/invoices/abgelegt');
    expect(submissions).toMatchObject([
      {
        clientId: client.id,
        number: 'EXT-2026-19',
        issueDate: '2026-07-03',
        dueDate: '2026-07-20',
        totalAmount: 37.9,
        vatRatePct: 7,
        subject: 'Externe Abrechnung',
        pdf: { name: 'beleg.pdf', size: pdf.length },
      },
    ]);
  });
});
