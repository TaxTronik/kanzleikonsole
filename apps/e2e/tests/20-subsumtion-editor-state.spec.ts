import { test, expect, type Page } from '@playwright/test';
import { composeProps, mountSubsumtion, reviewDocumentProps } from './helpers/subsumtion';

type EditorCall = {
  name: string;
  input: {
    text: string;
    doc: { content: Array<{ content: Array<{ marks: Array<{ type: string }> }> }> };
  };
};

// RISK-AI-SUGGESTION-001: editor state only; no engine, legal assessment or persisted marking is mocked as approved.
test.describe('Subsumtion: echte Editorzustände mit synthetischen Action-Grenzen', () => {
  for (const source of ['document', 'file'] as const) {
    test(`Dokumentimport erhält bereits formatierte Absätze (${source})`, async ({ page }) => {
      await mountSubsumtion(page, 'workspace', composeProps);
      const editor = page.locator('.tiptap');
      await editor.fill('Vorhandener Text');
      await editor.press('ControlOrMeta+a');
      await page.getByRole('button', { name: 'Fett', exact: true }).click();
      await expect(editor.locator('strong')).toHaveText('Vorhandener Text');
      await beginImport(page, source);
      await page.evaluate(
        "globalThis.__resolveImport({ok:true,text:'Importierter Text',suggestedTitle:'Importvorschlag'})",
      );
      await expect(editor).toContainText('Importierter Text');
      await expect(editor.locator('strong')).toHaveText('Vorhandener Text');
      await page.getByRole('button', { name: 'Analysieren', exact: true }).click();
      const calls = await page.evaluate<EditorCall[]>('globalThis.__calls');
      const analysis = calls.find((call) => call.name === 'analyzeAction')!;
      expect(analysis.input.text).toBe('Vorhandener Text\n\nImportierter Text');
      expect(analysis.input.doc.content[0]?.content[0]?.marks).toContainEqual({ type: 'bold' });
    });
    test(`später Importvorschlag überschreibt keinen zwischenzeitlich eingegebenen Titel (${source})`, async ({
      page,
    }) => {
      await mountSubsumtion(page, 'workspace', composeProps);
      await beginImport(page, source);
      await page.getByLabel('Bezeichnung', { exact: true }).fill('Mein eigener Titel');
      await page.evaluate(
        "globalThis.__resolveImport({ok:true,text:'Importierter Text',suggestedTitle:'Importvorschlag'})",
      );
      await expect(page.locator('.tiptap')).toContainText('Importierter Text');
      await expect(page.getByLabel('Bezeichnung', { exact: true })).toHaveValue(
        'Mein eigener Titel',
      );
    });
  }
  test('fehlgeschlagene Formatierung wird ohne weitere Eingabe erneut gespeichert', async ({
    page,
  }) => {
    await mountSubsumtion(page, 'document', reviewDocumentProps, 1);
    await page.locator('.tiptap').click();
    await page.locator('.tiptap').press('ControlOrMeta+a');
    await page.getByRole('button', { name: 'Fett', exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate('globalThis.__calls.filter(c=>c.name==="reformatAnalysisAction").length'),
        { timeout: 6000 },
      )
      .toBe(2);
    await expect(page.getByText('Formatierung gespeichert', { exact: true })).toBeVisible();
    const saves = await page.evaluate<EditorCall[]>(
      'globalThis.__calls.filter(c=>c.name==="reformatAnalysisAction")',
    );
    expect(saves[1]?.input.doc).toEqual(saves[0]?.input.doc);
  });
  test('nach fehlgeschlagenem älteren Save wird die neueste Formatierung gespeichert', async ({
    page,
  }) => {
    await mountSubsumtion(page, 'document', reviewDocumentProps);
    await page.evaluate('globalThis.__deferSave=true');
    await page.locator('.tiptap').click();
    await page.locator('.tiptap').press('ControlOrMeta+a');
    await page.getByRole('button', { name: 'Fett', exact: true }).click();
    await expect.poll(() => page.evaluate('globalThis.__calls.length'), { timeout: 4000 }).toBe(1);
    await page.getByRole('button', { name: 'Kursiv', exact: true }).click();
    await page.evaluate('globalThis.__resolveSave({ok:false,error:"Synthetic save failure"})');
    await expect.poll(() => page.evaluate('globalThis.__calls.length'), { timeout: 6000 }).toBe(2);
    const saves = await page.evaluate<EditorCall[]>('globalThis.__calls');
    expect(saves[1]?.input.doc.content[0]?.content[0]?.marks).toEqual(
      expect.arrayContaining([{ type: 'bold' }, { type: 'italic' }]),
    );
    await expect(page.getByText('Formatierung gespeichert', { exact: true })).toBeVisible();
  });
  test('Inhaltsänderungen brechen wartende Formatierungswiederholungen ab', async ({ page }) => {
    await page.clock.install();
    await mountSubsumtion(page, 'document', reviewDocumentProps, 1);
    await page.locator('.tiptap').click();
    await page.locator('.tiptap').press('ControlOrMeta+a');
    await page.getByRole('button', { name: 'Fett', exact: true }).click();
    await page.clock.runFor(1100);
    await expect(
      page.getByText('Speichern fehlgeschlagen — wird erneut versucht', { exact: true }),
    ).toBeVisible();
    await page.locator('.tiptap').fill('Geänderter Inhalt');
    await page.clock.runFor(5000);
    expect(await page.evaluate('globalThis.__calls.length')).toBe(1);
    await expect(page.getByText(/Der Text weicht vom analysierten Sachverhalt ab/)).toBeVisible();
  });
  test('entzogene Bearbeitbarkeit stoppt wartende Formatierungswiederholungen', async ({
    page,
  }) => {
    await page.clock.install();
    await mountSubsumtion(page, 'document', reviewDocumentProps, 1);
    await page.locator('.tiptap').click();
    await page.locator('.tiptap').press('ControlOrMeta+a');
    await page.getByRole('button', { name: 'Fett', exact: true }).click();
    await page.clock.runFor(1100);
    await expect(
      page.getByText('Speichern fehlgeschlagen — wird erneut versucht', { exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('subsumtion-props', { detail: { canEdit: false } })),
    );
    await expect(page.locator('.tiptap')).toHaveAttribute('contenteditable', 'false');
    await page.clock.runFor(5000);
    expect(await page.evaluate('globalThis.__calls.length')).toBe(1);
  });
  test('Review-Tabwechsel erhält den tatsächlichen Editor und dessen Formatierung', async ({
    page,
  }) => {
    await mountSubsumtion(
      page,
      'workspace',
      {
        ...composeProps,
        initial: {
          id: 'analysis-a',
          sourceText: 'Alpha Beta',
          title: 'Testanalyse',
          textHash: 'synthetic',
          sourceDoc: null,
          vertraulich: false,
          verdeckt: false,
          llmEnrichedAt: null,
          archivedAt: null,
          markings: [],
        },
      },
      1,
    );
    await page.locator('.tiptap').click();
    await page.locator('.tiptap').press('ControlOrMeta+a');
    await page.getByRole('button', { name: 'Fett', exact: true }).click();
    await expect(page.getByText('Synthetic save failure', { exact: true })).toBeVisible({
      timeout: 4000,
    });
    await page.getByRole('button', { name: 'Recherche', exact: true }).click();
    await expect(page).toHaveURL(/\?view=recherche$/);
    await expect(page.locator('.tiptap')).toBeHidden();
    await page.getByRole('button', { name: 'Subsumtion', exact: true }).click();
    await expect(page.locator('.tiptap')).toHaveCount(1);
    await expect(page.locator('.tiptap strong')).toHaveText('Alpha Beta');
    await expect(page.getByText('Formatierung gespeichert', { exact: true })).toBeVisible({
      timeout: 6000,
    });
    await expect(page.getByText('Synthetic save failure', { exact: true })).toHaveCount(0);
  });
});

async function beginImport(page: Page, source: 'document' | 'file') {
  if (source === 'document') {
    await page.getByRole('combobox').selectOption('file-a');
    await page.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  } else {
    await page.locator('input[type="file"]').setInputFiles({
      name: 'synthetisch.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Importierter Text'),
    });
    await expect.poll(() => page.evaluate('typeof globalThis.__resolveImport')).toBe('function');
  }
}
