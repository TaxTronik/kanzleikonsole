import { test, expect } from '@playwright/test';
import { mountReminderTickets, ticketDetail, ticketProps } from './helpers/reminder-tickets';

test.describe('REMINDER-TICKET-001 – Ticketbedienung im tatsächlichen Renderer', () => {
  test('verlinkt nur aufgelöste Ticketnummern in Beschreibung und Unterhaltung und zeigt Backlinks', async ({
    page,
  }) => {
    await mountReminderTickets(page, 'detail', ticketProps);
    await expect(page.getByRole('link', { name: '#102', exact: true })).toHaveCount(2);
    await expect(page.getByRole('link', { name: '#999', exact: true })).toHaveCount(0);
    await expect(page.getByText('Bitte #102 beachten.', { exact: false })).toContainText(
      'https://example.test/#102 und abc#102',
    );
    await expect(page.getByRole('link', { name: '#103 Späterer Auftrag' })).toBeVisible();
    await expect(page.getByText('Verweist auf dieses Ticket')).toBeVisible();
  });

  test('hält archivierte Tickets schreibgeschützt und bietet Wiederherstellen ohne Öffnen an', async ({
    page,
  }) => {
    await mountReminderTickets(page, 'detail', {
      ...ticketProps,
      detail: {
        ...ticketDetail,
        doneAt: '2026-09-07T00:00:00.000Z',
        archivedAt: '2026-09-07T01:00:00.000Z',
        canRestore: true,
        attachments: [
          {
            id: 'attachment-a',
            title: 'Beleg.pdf',
            mimeType: 'application/pdf',
            createdAt: '2026-09-07T00:00:00.000Z',
            uploadedByName: 'Anna Beispiel',
          },
        ],
      },
    });
    await expect(page.getByRole('textbox')).toHaveCount(0);
    for (const name of [
      'Erledigt',
      'Zurückholen',
      'Zuständige ändern',
      'Datei anhängen',
      'Senden',
      'Neues verknüpftes Ticket',
    ])
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Beleg.pdf herunterladen' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Wiederherstellen', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (globalThis as unknown as { __calls: { name: string; input: unknown }[] }).__calls.filter(
            (x) => x.name === 'restoreReminderAction',
          ),
        ),
      )
      .toEqual([{ name: 'restoreReminderAction', input: { id: ticketDetail.id } }]);
  });

  test('bietet Archivieren nur am erledigten steuerbaren Ticket an', async ({ page }) => {
    await mountReminderTickets(page, 'detail', {
      ...ticketProps,
      detail: { ...ticketDetail, doneAt: '2026-09-07T00:00:00.000Z', canArchive: true },
    });
    await page.getByRole('button', { name: 'Archivieren', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (globalThis as unknown as { __calls: { name: string }[] }).__calls.some(
            (x) => x.name === 'archiveReminderAction',
          ),
        ),
      )
      .toBe(true);
    await page.evaluate(
      (detail) =>
        window.dispatchEvent(
          new CustomEvent('ticket-props', {
            detail: { canSteer: false, detail: { ...detail, canArchive: false } },
          }),
        ),
      ticketDetail,
    );
    await expect(page.getByRole('button', { name: 'Archivieren', exact: true })).toHaveCount(0);
  });

  test('legt optional ein verknüpftes Ticket mit eigenem Titel und Pflichtfälligkeit ohne Nachfragekette an', async ({
    page,
  }) => {
    await mountReminderTickets(page, 'detail', ticketProps);
    await page.getByRole('button', { name: 'Neues verknüpftes Ticket', exact: true }).click();
    await page.getByLabel('Titel', { exact: true }).fill('Weitere Belege prüfen');
    await page.getByLabel('Fällig', { exact: true }).fill('2026-09-21');
    await page
      .getByRole('textbox', { name: 'Beschreibung', exact: true })
      .fill('Eigenständiger nächster Auftrag');
    await page.getByRole('button', { name: 'Verknüpftes Ticket anlegen', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __calls: { name: string; input: unknown }[] }).__calls.find(
              (x) => x.name === 'cloneReminderAction',
            )?.input,
        ),
      )
      .toMatchObject({
        id: ticketDetail.id,
        alsNachfrage: false,
        alsVerknuepftesTicket: true,
        subject: 'Weitere Belege prüfen',
        dueDate: '2026-09-21',
      });
  });

  test('behält einen während des Sendens weitergeschriebenen Kommentar', async ({ page }) => {
    await mountReminderTickets(page, 'detail', ticketProps);
    await page.evaluate(() => Object.assign(globalThis, { __deferAction: true }));
    const comment = page.getByRole('textbox', { name: 'Kommentar', exact: true });
    await comment.fill('Erster Kommentar zu #102');
    await page.getByRole('button', { name: 'Kommentieren', exact: true }).click();
    await comment.fill('Zweiter Gedanke');
    await page.evaluate(() =>
      (globalThis as unknown as { __resolveAction: (result: unknown) => void }).__resolveAction({
        ok: true,
      }),
    );
    await expect(page.getByRole('button', { name: 'Kommentieren', exact: true })).toBeEnabled();
    await expect(comment).toHaveValue('Zweiter Gedanke');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __calls: { name: string; input: unknown }[] }).__calls.find(
              (x) => x.name === 'addReminderNoteAction',
            )?.input,
        ),
      )
      .toEqual({ id: ticketDetail.id, body: 'Erster Kommentar zu #102' });
  });

  test('zeigt beim gescheiterten Kommentar den Fehler und behält den Entwurf', async ({ page }) => {
    await mountReminderTickets(page, 'detail', ticketProps);
    await page.evaluate(() => Object.assign(globalThis, { __deferAction: true }));
    await page.getByRole('textbox', { name: 'Kommentar', exact: true }).fill('Nicht verlieren');
    await page.getByRole('button', { name: 'Kommentieren', exact: true }).click();
    await page.evaluate(() =>
      (globalThis as unknown as { __resolveAction: (result: unknown) => void }).__resolveAction({
        ok: false,
        error: 'Synthetischer Speicherfehler',
      }),
    );
    await expect(page.getByRole('alert')).toHaveText('Synthetischer Speicherfehler');
    await expect(page.getByRole('textbox', { name: 'Kommentar', exact: true })).toHaveValue(
      'Nicht verlieren',
    );
  });

  test('lässt im Archiv ohne Steuerberechtigung nur Lesen und Klonen zu', async ({ page }) => {
    await mountReminderTickets(page, 'detail', {
      ...ticketProps,
      canSteer: false,
      detail: {
        ...ticketDetail,
        doneAt: '2026-09-07T00:00:00.000Z',
        archivedAt: '2026-09-07T01:00:00.000Z',
      },
    });
    await expect(page.getByRole('button')).toHaveCount(1);
    await page.getByRole('button', { name: 'Klonen', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __calls: { name: string; input: unknown }[] }).__calls.find(
              (x) => x.name === 'cloneReminderAction',
            )?.input,
        ),
      )
      .toMatchObject({ id: ticketDetail.id, alsNachfrage: false });
  });

  test('erhält Herkunft und frühere Nachfrageketten neben der Unterhaltung', async ({ page }) => {
    await mountReminderTickets(page, 'detail', {
      ...ticketProps,
      detail: {
        ...ticketDetail,
        clientId: 'client-a',
        originResearchAnalysisId: 'analysis-a',
        originResearchMarkingId: 'marking-a',
        phoneNote: {
          id: 'phone-a',
          subject: 'Rückruf zur Buchführung',
          createdAt: '2026-09-07T00:00:00.000Z',
        },
        vorgaenger: [
          {
            id: 'old-ticket',
            ticketNumber: 90,
            archivedAt: '2026-09-01T00:00:00.000Z',
            subject: 'Ursprünglicher Auftrag',
            doneAt: '2026-09-01T00:00:00.000Z',
            dueDate: '2026-09-01T00:00:00.000Z',
          },
        ],
      },
    });
    await expect(
      page.getByRole('link', { name: 'Markierung im Subsumtions-Space öffnen' }),
    ).toHaveAttribute('href', '/staff/clients/client-a/subsumtion/analysis-a?marking=marking-a');
    await expect(page.getByRole('link', { name: 'Rückruf zur Buchführung' })).toHaveAttribute(
      'href',
      '/staff/phone-notes',
    );
    await page.getByText('Frühere Nachfragekette', { exact: true }).click();
    await expect(page.getByRole('link', { name: '#90 Ursprünglicher Auftrag' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Unterhaltung', exact: true })).toBeVisible();
  });

  test('zeigt die serverseitige Reihenfolge und eindeutige Nummern in der Übersicht', async ({
    page,
  }) => {
    const row = {
      ...ticketDetail,
      clientName: 'Intern',
      assigneeStaffIds: ['staff-a'],
      assigneeNames: ['Anna Beispiel'],
      predecessorId: null,
      noteCount: 0,
      attachmentCount: 0,
      successorCount: 0,
    };
    await mountReminderTickets(page, 'overview', {
      scope: 'mir',
      status: 'open',
      currentStaffId: 'staff-a',
      canPrioritizeAll: false,
      rows: [
        { ...row, ticketNumber: 105, subject: 'Server zuerst' },
        { ...row, id: 'other', ticketNumber: 104, subject: 'Server danach', priority: 'URGENT' },
      ],
    });
    await expect(page.getByRole('link')).toHaveText(['#105 Server zuerst', '#104 Server danach']);
    await page.getByRole('button', { name: 'Ticket #105 als erledigt markieren' }).click();
    await expect(page.getByRole('status')).toContainText('#105 Server zuerst');
    await page.getByRole('button', { name: 'Rückgängig' }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (globalThis as unknown as { __calls: { name: string; input: unknown }[] }).__calls.filter(
            (x) => x.name === 'reopenReminderAction',
          ),
        ),
      )
      .toEqual([{ name: 'reopenReminderAction', input: { id: ticketDetail.id } }]);
  });

  test('verlangt beim neuen Ticket weiterhin Titel und Fälligkeit', async ({ page }) => {
    await mountReminderTickets(page, 'new', {
      clients: [],
      staffOptions: ticketProps.staffOptions,
    });
    await page.getByRole('button', { name: 'Neues Ticket', exact: true }).click();
    const title = page.getByRole('textbox', { name: 'Titel', exact: true });
    const due = page.getByLabel('Fällig', { exact: true });
    await expect(title).toHaveAttribute('required', '');
    await expect(due).toHaveAttribute('required', '');
    await title.fill('Lokales Testticket');
    await due.fill('');
    await page.getByRole('button', { name: 'Anlegen', exact: true }).click();
    expect(await due.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(
      true,
    );
    expect(
      await page.evaluate(() => (globalThis as unknown as { __calls: unknown[] }).__calls),
    ).toEqual([]);
  });

  test('zeigt im Mandantenblock keine archivierten Tickets oder Löschaktion', async ({ page }) => {
    const row = {
      ...ticketDetail,
      notes: 'Beschreibung',
      assigneeNames: ['Anna Beispiel'],
      assigneeStaffIds: ['staff-a'],
    };
    await mountReminderTickets(page, 'client', {
      clientId: 'client-a',
      currentStaffId: 'staff-a',
      staffOptions: ticketProps.staffOptions,
      initial: [
        row,
        {
          ...row,
          id: 'done',
          ticketNumber: 102,
          subject: 'Erledigter Auftrag',
          doneAt: '2026-09-07T00:00:00.000Z',
          canArchive: true,
        },
        {
          ...row,
          id: 'archived',
          ticketNumber: 103,
          subject: 'Archivierter Auftrag',
          doneAt: '2026-09-07T00:00:00.000Z',
          archivedAt: '2026-09-07T01:00:00.000Z',
        },
      ],
    });
    await expect(page.getByRole('link', { name: '#101 Belege prüfen' })).toHaveAttribute(
      'href',
      '/staff/reminders/101',
    );
    await expect(page.getByText('Archivierter Auftrag', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Löschen', exact: true })).toHaveCount(0);
    await page.getByText('1 erledigt', { exact: true }).click();
    await page.getByRole('button', { name: 'Ticket #102 archivieren', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __calls: { name: string; input: unknown }[] }).__calls.find(
              (x) => x.name === 'archiveReminderAction',
            )?.input,
        ),
      )
      .toEqual({ id: 'done' });
  });
  test('blättert Kommentare und Anhänge unabhängig und führt neue Kommentare zur neuesten Seite', async ({
    page,
  }) => {
    await mountReminderTickets(page, 'detail', {
      ...ticketProps,
      detail: {
        ...ticketDetail,
        commentsPage: 2,
        commentsTotal: 401,
        attachmentsPage: 2,
        attachmentsTotal: 101,
      },
    });
    const comments = page.getByRole('navigation', { name: 'Kommentare blättern' });
    await expect(comments).toContainText('Seite 2 von 3');
    await expect(comments.getByRole('link', { name: 'Neuere' })).toHaveAttribute(
      'href',
      '/staff/reminders/101?attachmentsPage=2',
    );
    await expect(comments.getByRole('link', { name: 'Ältere' })).toHaveAttribute(
      'href',
      '/staff/reminders/101?commentsPage=3&attachmentsPage=2',
    );
    const attachments = page.getByRole('navigation', { name: 'Anhänge blättern' });
    await expect(attachments.getByRole('link', { name: 'Neuere' })).toHaveAttribute(
      'href',
      '/staff/reminders/101?commentsPage=2',
    );
    await page.getByRole('textbox', { name: 'Kommentar', exact: true }).fill('Neuester Kommentar');
    await page.getByRole('button', { name: 'Kommentieren', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __calls: { name: string; input: unknown }[] }).__calls.find(
              (x) => x.name === 'push',
            )?.input,
        ),
      )
      .toBe('/staff/reminders/101?attachmentsPage=2');
  });

  test('führt neue Anhänge zur neuesten Dateiseite und behält die gewählte Kommentarseite', async ({
    page,
  }) => {
    await mountReminderTickets(page, 'detail', {
      ...ticketProps,
      detail: {
        ...ticketDetail,
        commentsPage: 3,
        commentsTotal: 401,
        attachmentsPage: 2,
        attachmentsTotal: 101,
      },
    });
    await page.getByRole('button', { name: 'Datei anhängen', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __calls: { name: string; input: unknown }[] }).__calls.find(
              (x) => x.name === 'push',
            )?.input,
        ),
      )
      .toBe('/staff/reminders/101?commentsPage=3');
  });
  test('zieht nach Verlassen des Tickets eine verspätet abgeschlossene Wortmeldung nicht wieder in den alten Verlauf zurück', async ({
    page,
  }) => {
    await mountReminderTickets(page, 'detail', {
      ...ticketProps,
      detail: { ...ticketDetail, commentsPage: 2, commentsTotal: 401 },
    });
    await page.evaluate(() => Object.assign(globalThis, { __deferAction: true }));
    await page
      .getByRole('textbox', { name: 'Kommentar', exact: true })
      .fill('Kommentar vor Seitenwechsel');
    await page.getByRole('button', { name: 'Kommentieren', exact: true }).click();
    await page.evaluate(() => {
      Object.assign(globalThis, { __mode: 'new' });
      window.dispatchEvent(
        new CustomEvent('ticket-props', { detail: { clients: [], staffOptions: [] } }),
      );
    });
    await expect(page.getByRole('button', { name: 'Neues Ticket', exact: true })).toBeVisible();
    await page.evaluate(async () => {
      (globalThis as unknown as { __resolveAction: (result: unknown) => void }).__resolveAction({
        ok: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      await page.evaluate(() =>
        (globalThis as unknown as { __calls: { name: string }[] }).__calls.filter(
          (call) => call.name === 'push' || call.name === 'refresh',
        ),
      ),
    ).toEqual([]);
  });
  test('zieht nach Verlassen des Tickets einen verspätet abgeschlossenen Upload nicht zur alten Dateiseite zurück', async ({
    page,
  }) => {
    await mountReminderTickets(page, 'detail', {
      ...ticketProps,
      detail: { ...ticketDetail, attachmentsPage: 2, attachmentsTotal: 101 },
    });
    await page.evaluate(() => Object.assign(globalThis, { __deferUpload: true }));
    await page.getByRole('button', { name: 'Datei anhängen', exact: true }).click();
    await page.evaluate(() => {
      Object.assign(globalThis, { __mode: 'new' });
      window.dispatchEvent(
        new CustomEvent('ticket-props', { detail: { clients: [], staffOptions: [] } }),
      );
    });
    await expect(page.getByRole('button', { name: 'Neues Ticket', exact: true })).toBeVisible();
    await page.evaluate(() =>
      (globalThis as unknown as { __resolveUpload: () => void }).__resolveUpload(),
    );
    expect(
      await page.evaluate(() =>
        (globalThis as unknown as { __calls: { name: string }[] }).__calls.filter(
          (call) => call.name === 'push' || call.name === 'refresh',
        ),
      ),
    ).toEqual([]);
  });
});
