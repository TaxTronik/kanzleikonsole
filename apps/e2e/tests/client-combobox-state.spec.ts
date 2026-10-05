import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// Fachkatalog: ACCESS-SEARCH-SCOPE-001
// Echte ClientCombobox im Browser; GET /api/staff/clients/search wird als
// Route simuliert. Dieser Test ersetzt weder den RBAC-/PostgreSQL-Nachweis der
// Suche (invoice-selection-db.test.tsx) noch einen Lauf gegen die App.
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');
const webRoot = dirname(webRequire.resolve('./package.json'));
const ORIGIN = 'http://client-combobox.test';
let bundle: Promise<string> | undefined;

type Option = {
  id: string;
  name: string;
  datevNo: string | null;
  addisonNo: string | null;
  allowActive: boolean;
  mandateEnded: boolean;
};
type Result = { clients: Option[]; limited: boolean; mode: 'search' | 'assigned' };

const option = (id: string, name: string, patch: Partial<Option> = {}): Option => ({
  id,
  name,
  datevNo: null,
  addisonNo: null,
  allowActive: true,
  mandateEnded: false,
  ...patch,
});
const MUSTER = option('11111111-1111-4111-8111-111111111111', 'Muster GmbH', { datevNo: '1001' });
const MUSTERMANN = option('22222222-2222-4222-8222-222222222222', 'Mustermann KG');
const ONBOARDING = option('33333333-3333-4333-8333-333333333333', 'Muster Onboarding', {
  allowActive: false,
});
const ASSIGNED = option('44444444-4444-4444-8444-444444444444', 'Zugeordnet AG');
const STALE = option('55555555-5555-4555-8555-555555555555', 'Veraltet GmbH');

function defaultResponse(url: URL): Result {
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  if (!q) return { clients: [ASSIGNED], limited: false, mode: 'assigned' };
  return {
    clients: [MUSTER, MUSTERMANN, ONBOARDING].filter((c) => c.name.toLowerCase().includes(q)),
    limited: false,
    mode: 'search',
  };
}

function comboboxBundle() {
  bundle ??= build({
    stdin: {
      contents: `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ClientCombobox} from './src/components/ui/client-combobox';
function Fixture(){
 const [submitted,setSubmitted]=useState('');
 return <form aria-label="Testformular" onSubmit={e=>{e.preventDefault();setSubmitted(JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))));}}>
  <label htmlFor="client">Mandant</label>
  <ClientCombobox id="client" name="clientId" {...globalThis.__props}/>
  <button type="submit">Absenden</button>
  <output aria-label="Ergebnis">{submitted}</output>
 </form>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
      loader: 'tsx',
      resolveDir: webRoot,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
  }).then((result) => result.outputFiles[0]!.text);
  return bundle;
}

async function mount(
  page: Page,
  props: Record<string, unknown> = {},
  respond: (url: URL) => Promise<Result> | Result = defaultResponse,
) {
  const source = await comboboxBundle();
  const requests: string[] = [];
  await page.addInitScript((value) => Object.assign(globalThis, { __props: value }), props);
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture.js') {
      return route.fulfill({ contentType: 'application/javascript', body: source });
    }
    if (url.pathname === '/api/staff/clients/search') {
      requests.push(url.search);
      const body = await respond(url);
      // Eine inzwischen abgebrochene Anfrage lässt sich nicht mehr beantworten.
      return route
        .fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
        .catch(() => undefined);
    }
    return route.fulfill({
      contentType: 'text/html',
      // Ohne Tailwind: nur die Positionierung des Vorschlagspanels nachbilden,
      // damit die geöffnete Liste wie in der App überlagert statt zu verschieben.
      body: `<html><head><style>${FIXTURE_CSS}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`);
  const input = page.getByRole('combobox', { name: 'Mandant' });
  await expect(input).toBeVisible();
  return { input, requests };
}

const FIXTURE_CSS = [
  '.relative{position:relative}',
  '.absolute{position:absolute;background:#fff}',
  '.top-full{top:100%}',
  '.left-0{left:0}',
  '.right-0{right:0}',
  '.z-40{z-index:40}',
  '.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
].join('');

const hidden = (page: Page) => page.locator('input[type="hidden"][name="clientId"]');
const result = (page: Page) => page.getByLabel('Ergebnis');

test('schlägt ohne Begriff Zuordnungen vor und wählt Suchtreffer per Tastatur', async ({
  page,
}) => {
  const { input, requests } = await mount(page, { filters: ['active'] });
  await input.focus();
  await expect(page.getByText('Ihre zugeordneten Mandanten')).toBeVisible();
  await expect(page.getByRole('option', { name: /^Zugeordnet AG/ })).toBeVisible();
  expect(requests[0]).toBe('?filter=active');

  await input.pressSequentially('mus');
  const first = page.getByRole('option', { name: /^Muster GmbH/ });
  const second = page.getByRole('option', { name: /^Mustermann KG/ });
  await expect(first).toBeVisible();
  expect(requests.at(-1)).toBe('?q=mus&filter=active');

  await input.press('ArrowDown');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(input).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
  await input.press('ArrowDown');
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowUp');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');

  await expect(input).toHaveValue('Muster GmbH');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(hidden(page)).toHaveValue(MUSTER.id);
  await page.getByRole('button', { name: 'Absenden' }).click();
  await expect(result(page)).toHaveText(JSON.stringify({ clientId: MUSTER.id }));
});

test('zeigt GwG-offene Mandanten im Modus „disabled" nur an', async ({ page }) => {
  const { input } = await mount(page, { inactive: 'disabled' });
  await input.fill('mus');
  const pending = page.getByRole('option', { name: /^Muster Onboarding/ });
  await expect(pending).toHaveAttribute('aria-disabled', 'true');
  await expect(pending).toContainText('Noch nicht auswählbar: GwG-Prüfung ausstehend');
  await input.press('End');
  await expect(pending).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(input).toHaveValue('mus');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(hidden(page)).toHaveValue('');
});

test('übernimmt eine Vorauswahl, hebt sie beim Tippen auf und sendet ungewählten Text nicht', async ({
  page,
}) => {
  const { input } = await mount(page, {
    defaultValue: { id: MUSTERMANN.id, name: MUSTERMANN.name },
  });
  await expect(input).toHaveValue('Mustermann KG');
  await expect(hidden(page)).toHaveValue(MUSTERMANN.id);

  await input.fill('Mustermann K');
  await expect(hidden(page)).toHaveValue('');
  await input.press('Escape');
  await page.getByRole('button', { name: 'Absenden' }).click();
  // Die Formularvalidierung blockiert und fokussiert das ungültige Feld.
  await expect(input).toBeFocused();
  await expect(result(page)).toHaveText('');
  expect(await input.evaluate((element: HTMLInputElement) => element.validationMessage)).toBe(
    'Bitte einen Mandanten aus der Liste auswählen.',
  );

  // Leeres optionales Feld ist gültig und sendet bewusst keinen Mandanten.
  await input.fill('');
  await input.press('Escape');
  await page.getByRole('button', { name: 'Absenden' }).click();
  await expect(result(page)).toHaveText(JSON.stringify({ clientId: '' }));
});

test('entfernt eine Auswahl per Schaltfläche und fokussiert die Suche', async ({ page }) => {
  const { input } = await mount(page, { defaultValue: { id: MUSTER.id, name: MUSTER.name } });
  await page.getByRole('button', { name: 'Auswahl Muster GmbH entfernen' }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(hidden(page)).toHaveValue('');
});

test('schließt mit Escape nur die Liste und öffnet sie mit Pfeil ab erneut', async ({ page }) => {
  const { input } = await mount(page);
  await input.focus();
  await expect(page.getByRole('listbox')).toBeVisible();
  await input.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await input.press('ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();
});

test('zeigt nur Treffer zum aktuellen Begriff und bricht veraltete Anfragen ab', async ({
  page,
}) => {
  const { input, requests } = await mount(page, {}, async (url) => {
    if (url.searchParams.get('q') === 'mu') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { clients: [STALE], limited: false, mode: 'search' };
    }
    return defaultResponse(url);
  });
  await input.fill('mu');
  await expect.poll(() => requests.includes('?q=mu')).toBe(true);
  await input.pressSequentially('s');
  await expect(page.getByRole('option', { name: /^Muster GmbH/ })).toBeVisible();
  // Die langsame Antwort zum alten Begriff darf die Liste nie ersetzen.
  await page.waitForTimeout(1800);
  await expect(page.getByText('Veraltet GmbH')).toHaveCount(0);
  await expect(page.getByRole('option', { name: /^Muster GmbH/ })).toBeVisible();
});

for (const blockEnterSubmit of [false, true]) {
  test(`Enter bei geschlossener Liste sendet das Formular ${blockEnterSubmit ? 'in Hilfsauswahlen nicht' : 'wie ein Textfeld'} ab`, async ({
    page,
  }) => {
    const { input } = await mount(page, {
      defaultValue: { id: MUSTER.id, name: MUSTER.name },
      blockEnterSubmit,
    });
    await input.focus();
    await input.press('Enter');
    if (blockEnterSubmit) {
      await page.waitForTimeout(300);
      await expect(result(page)).toHaveText('');
    } else {
      await expect(result(page)).toHaveText(JSON.stringify({ clientId: MUSTER.id }));
    }
  });
}
