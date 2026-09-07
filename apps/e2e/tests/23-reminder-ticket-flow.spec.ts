// Fachkatalog: REMINDER-TICKET-001. Echte UI → Server Actions → Datenbank, keine GET-/Action-Mocks.
import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

function exactTitle(title: string): RegExp {
  return new RegExp(`^#([1-9]\\d*) ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

async function createTicket(page: Page, title: string, description: string): Promise<number> {
  await page.goto(`/staff/reminders?scope=mir&status=open&q=${encodeURIComponent(title)}`);
  await page.getByRole('button', { name: 'Neues Ticket', exact: true }).click();
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('textbox', { name: 'Titel', exact: true }) });
  await form.getByRole('textbox', { name: 'Titel', exact: true }).fill(title);
  await form.getByLabel('Fällig', { exact: true }).fill('2030-09-21');
  await form.getByRole('textbox', { name: /^Beschreibung/ }).fill(description);
  await form.getByRole('button', { name: 'Anlegen', exact: true }).click();
  const link = page.getByRole('link', { name: exactTitle(title) });
  await expect(link).toBeVisible();
  const number = Number((await link.textContent())!.match(/^#([1-9]\d*)/)![1]);
  await link.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`#${number} ${title}`);
  return number;
}

test('REMINDER-TICKET-001 – Tickets anlegen, erwähnen, verknüpfen, archivieren und erledigt wiederherstellen', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const run = `E2E Ticket ${randomUUID().slice(0, 8)}`;
  await loginAsAdmin(page);
  const targetTitle = `${run} Ziel`;
  const target = await createTicket(
    page,
    targetTitle,
    'Synthetische Zielaufgabe für die lokale Ticketabnahme.',
  );
  const sourceTitle = `${run} Quelle`;
  const source = await createTicket(
    page,
    sourceTitle,
    `Ergebnis bitte mit #${target} abstimmen. Ungültige Schreibweise #000123 bleibt Text.`,
  );

  await expect(
    page
      .getByRole('region', { name: 'Beschreibung', exact: true })
      .getByRole('link', { name: `#${target}`, exact: true }),
  ).toHaveAttribute('href', `/staff/reminders/${target}`);
  await expect(page.getByRole('link', { name: '#000123', exact: true })).toHaveCount(0);
  await page
    .getByRole('textbox', { name: 'Kommentar', exact: true })
    .fill(`Nachfrage zu #${target}: Bitte die Belege ergänzen.`);
  await page.getByRole('button', { name: 'Kommentieren', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Unterhaltung', exact: true })
      .getByText(`Nachfrage zu #${target}: Bitte die Belege ergänzen.`),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Unterhaltung', exact: true })
      .getByRole('link', { name: `#${target}`, exact: true }),
  ).toBeVisible();

  await page.goto(`/staff/reminders/${target}`);
  await expect(
    page
      .getByRole('region', { name: 'Verknüpfte Tickets', exact: true })
      .getByRole('link', { name: `#${source} ${sourceTitle}` }),
  ).toBeVisible();
  await expect(page.getByText('Verweist auf dieses Ticket', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Erledigt', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Archivieren', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Archivieren', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Wiederherstellen', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Kommentar', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Datei anhängen', exact: true })).toHaveCount(0);

  const archived = await page.goto(`/staff/reminders/${target}`);
  expect(archived?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`#${target} ${targetTitle}`);
  await expect(
    page
      .getByRole('region', { name: 'Verknüpfte Tickets', exact: true })
      .getByRole('link', { name: `#${source} ${sourceTitle}` }),
  ).toBeVisible();
  await page.goto(
    `/staff/reminders?scope=alle&status=archived&q=${encodeURIComponent(`#${target}`)}`,
  );
  await expect(page.getByRole('link', { name: exactTitle(targetTitle) })).toBeVisible();
  await page.getByRole('link', { name: exactTitle(targetTitle) }).click();
  await page.getByRole('button', { name: 'Wiederherstellen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Zurückholen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Erledigt', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Archivieren', exact: true })).toBeVisible();
  await page.goto(`/staff/reminders?scope=alle&status=done&q=${encodeURIComponent(`#${target}`)}`);
  await expect(page.getByRole('link', { name: exactTitle(targetTitle) })).toBeVisible();
  await page.goto(
    `/staff/reminders?scope=alle&status=archived&q=${encodeURIComponent(`#${target}`)}`,
  );
  await expect(page.getByRole('link', { name: exactTitle(targetTitle) })).toHaveCount(0);

  await page.goto(`/staff/reminders/${source}`);
  await page.getByRole('button', { name: 'Neues verknüpftes Ticket', exact: true }).click();
  const linkedTitle = `${run} Eigenständiger Auftrag`;
  await page.getByRole('textbox', { name: 'Titel', exact: true }).fill(linkedTitle);
  await page.getByLabel('Fällig', { exact: true }).fill('2030-10-01');
  await page
    .getByRole('textbox', { name: 'Beschreibung', exact: true })
    .fill('Neue Aufgabe, keine Nachfragekette.');
  await page.getByRole('button', { name: 'Verknüpftes Ticket anlegen', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(exactTitle(linkedTitle));
  const linked = Number(
    (await page.getByRole('heading', { level: 1 }).textContent())!.match(/^#([1-9]\d*)/)![1],
  );
  await expect(
    page
      .getByRole('region', { name: 'Verknüpfte Tickets', exact: true })
      .getByRole('link', { name: `#${source} ${sourceTitle}` }),
  ).toBeVisible();
  await expect(page.getByText('Frühere Nachfragekette', { exact: true })).toHaveCount(0);
  await page.goto(`/staff/reminders/${source}`);
  await expect(
    page
      .getByRole('region', { name: 'Verknüpfte Tickets', exact: true })
      .getByRole('link', { name: `#${linked} ${linkedTitle}` }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('ticket-detail.png'), fullPage: true });
  expect(pageErrors).toEqual([]);
  await testInfo.attach('synthetic-ticket-identities', {
    body: JSON.stringify({ run, target, source, linked }),
    contentType: 'application/json',
  });
});
