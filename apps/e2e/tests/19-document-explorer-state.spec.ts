import { test, expect } from '@playwright/test';
import {
  browserProps,
  fileA,
  fileB,
  folderA,
  folderB,
  mountDocumentExplorer,
  updateDocumentExplorer,
} from './helpers/document-explorer';

test.describe('Dokumentenansichten: isolierte echte Komponenten ohne App-/DB-Dienste', () => {
  for (const selected of [false, true]) {
    test(`Zeilenbefehl verschiebt genau die Datei, vorausgewählt: ${selected}`, async ({
      page,
    }) => {
      await mountDocumentExplorer(page, browserProps);
      const row = page.locator('[data-document-id="file-a"]');
      if (selected) await row.getByRole('checkbox').check();
      await row.getByTitle('Verschieben', { exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Verschieben nach…', exact: true });
      await dialog.getByText(folderB.name, { exact: true }).click();
      await dialog.getByRole('button', { name: 'Hierher verschieben' }).click();
      await expect
        .poll(() => page.evaluate('globalThis.__documentActions'))
        .toEqual([
          { action: 'setDocumentFolder', input: { documentId: fileA.id, folderId: folderB.id } },
        ]);
      await expect(dialog).toHaveCount(0);
    });
  }

  test('Ordner- und URL-Suchwechsel entfernen alte Auswahl und übernehmen den neuen Suchtext', async ({
    page,
  }) => {
    await mountDocumentExplorer(page, { ...browserProps, q: 'alpha' });
    await page.getByRole('checkbox').check();
    await updateDocumentExplorer(page, {
      currentFolderId: folderB.id,
      crumbs: [{ label: folderB.name, href: '/staff/documents?client=client-a&folder=folder-b' }],
      entries: [fileB],
      q: 'beta',
    });
    await expect(page.getByText('1 ausgewählt', { exact: true })).toHaveCount(0);
    await expect(page.getByPlaceholder('In diesem Ordner suchen…')).toHaveValue('beta');
    await expect(
      page.locator('[data-document-id="file-b"]').getByRole('checkbox'),
    ).not.toBeChecked();
  });

  test('Bereichswechsel schließen auch den geteilten Ordnerdialog des vorherigen Mandanten', async ({
    page,
  }) => {
    await mountDocumentExplorer(page, browserProps);
    await page.getByRole('button', { name: 'Neuer Ordner' }).click();
    await expect(page.getByRole('dialog', { name: 'Neuer Ordner', exact: true })).toBeVisible();
    await updateDocumentExplorer(page, {
      scope: { clientId: 'client-b', typeParam: 'business' },
      crumbs: [{ label: folderB.name, href: '/staff/documents?client=client-b&folder=folder-b' }],
      currentFolderId: folderB.id,
      entries: [fileB],
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate('globalThis.__documentActions')).toEqual([]);
  });

  test('gewöhnlicher Refresh im selben Bereich erhält Auswahl und ungesendeten Suchtext', async ({
    page,
  }) => {
    await mountDocumentExplorer(page, browserProps);
    await page.getByPlaceholder('In diesem Ordner suchen…').fill('Entwurf');
    await page.getByRole('checkbox').check();
    await updateDocumentExplorer(page, { entries: [{ ...fileA, name: 'Aktualisiert.pdf' }] });
    await expect(page.getByRole('checkbox')).toBeChecked();
    await page.getByRole('button', { name: 'Aufheben', exact: true }).click();
    await expect(page.getByPlaceholder('In diesem Ordner suchen…')).toHaveValue('Entwurf');
  });

  test('Mandantenwechsel setzt auch im eingebetteten Explorer Ordner und Suchtext zurück', async ({
    page,
  }) => {
    const document = {
      ...fileA,
      title: 'Alpha.pdf',
      classification: 'GENERAL',
      folderId: folderA.id,
    };
    await mountDocumentExplorer(page, {
      variant: 'embedded',
      clientId: 'client-a',
      folders: [folderA],
      documents: [document],
      scopeLabel: 'Mandant A',
    });
    await page.getByText(folderA.name, { exact: true }).click();
    await page.getByPlaceholder('In Auswahl suchen…').fill('Alpha');
    await updateDocumentExplorer(page, {
      clientId: 'client-b',
      folders: [folderB],
      documents: [{ ...document, id: 'file-b', title: 'Beta.pdf', folderId: folderB.id }],
      scopeLabel: 'Mandant B',
    });
    await expect(page.getByPlaceholder('In Auswahl suchen…')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Beta.pdf', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hochladen', exact: true })).toHaveAttribute(
      'data-upload-folder',
      '',
    );
  });

  test('Embedded-Refresh im selben Mandanten erhält Ordner und lokalen Suchfilter', async ({
    page,
  }) => {
    const document = {
      ...fileA,
      title: 'Alpha.pdf',
      classification: 'GENERAL',
      folderId: folderA.id,
    };
    await mountDocumentExplorer(page, {
      variant: 'embedded',
      clientId: 'client-a',
      folders: [folderA, folderB],
      documents: [document],
      scopeLabel: 'Mandant A',
    });
    await page.getByText(folderA.name, { exact: true }).click();
    await page.getByPlaceholder('In Auswahl suchen…').fill('Alpha');
    await updateDocumentExplorer(page, {
      folders: [{ ...folderA }, { ...folderB }],
      documents: [
        { ...document, title: 'Alpha aktualisiert.pdf' },
        { ...document, id: 'file-b', title: 'Beta.pdf', folderId: folderB.id },
      ],
    });
    await expect(page.getByPlaceholder('In Auswahl suchen…')).toHaveValue('Alpha');
    await expect(
      page.getByRole('button', { name: 'Alpha aktualisiert.pdf', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Beta.pdf', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Hochladen', exact: true })).toHaveAttribute(
      'data-upload-folder',
      folderA.id,
    );
  });
});
