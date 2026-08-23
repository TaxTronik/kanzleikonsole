import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function section(contents: string, start: string, end?: string): string {
  const startAt = contents.indexOf(start);
  expect(startAt, `Startmarker fehlt: ${start}`).toBeGreaterThanOrEqual(0);
  const endAt = end ? contents.indexOf(end, startAt + start.length) : contents.length;
  expect(endAt, `Endmarker fehlt: ${end ?? '<EOF>'}`).toBeGreaterThan(startAt);
  return contents.slice(startAt, endAt);
}

function expectOrdered(contents: string, ...needles: string[]): void {
  let cursor = -1;
  for (const needle of needles) {
    const next = contents.indexOf(needle, cursor + 1);
    expect(next, `Reihenfolge/Marker verletzt: ${needle}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe('Rechnungsarchiv-Lock – Aufrufer-Reihenfolge', () => {
  const actions = source('../../../app/staff/(protected)/invoices/actions.ts');
  const archive = source('../archive.ts');
  const xrechnungRoute = source('../../../app/api/staff/invoices/[id]/xrechnung/route.ts');

  it('serialisiert den finalen DRAFT→SENT-Claim vor jeder Statusentscheidung', () => {
    expectOrdered(
      section(actions, 'async function finalizeInvoiceSendTx', 'type NonSentInvoiceResult'),
      'lockInvoiceArchiveTx(',
      'claimInvoiceDraftForSend(',
    );
  });

  it('serialisiert Entwurfsstorno vor Lesen und Aufräumen des Archivs', () => {
    expectOrdered(
      section(actions, 'export async function cancelInvoiceAction', 'const RESERVED_AUTO_NUMBER'),
      'lockInvoiceArchiveTx(',
      'tx.invoice.findUnique(',
      'discardNeverSentDraftArchiveTx(',
      'cancelOriginalAfterDeliveredStornoTx(',
    );
  });

  it('serialisiert die finale Archivverknüpfung vor dem Status-Recheck', () => {
    expectOrdered(
      section(
        archive,
        'async function linkGeneratedArchiveTx',
        'async function commitGeneratedArchiveLink',
      ),
      'lockInvoiceArchiveTx(',
      'tx.invoice.findFirst(',
      "fresh.status === 'CANCELLED'",
      'tx.document.create(',
      'tx.invoice.update(',
    );
    expectOrdered(
      section(archive, 'async function commitLazyXrechnungDocument', 'type ArchiveOptions'),
      'lockInvoiceArchiveTx(',
      'tx.invoice.findFirst(',
      "fresh.status === 'CANCELLED'",
      'const existing = fresh.xrechnungDocument',
      'tx.document.create(',
    );
    expect(
      section(archive, 'async function commitLazyXrechnungDocument', 'type ArchiveOptions'),
    ).not.toContain('tx.document.findFirst(');
  });

  it('liefert DRAFT nur als frische Vorschau und nutzt für ausgestellte XML den kanonischen Archivpfad', () => {
    expectOrdered(
      section(xrechnungRoute, "if (invoice.status === 'DRAFT')", '// Audit-Log'),
      'const rendered = renderXml(',
      'recheckDraftXmlPreview(',
      "rechecked === 'current'",
      'useArchive = true',
      'if (useArchive)',
      'resolveIssuedXmlArchive(',
    );
    expectOrdered(
      section(
        xrechnungRoute,
        'async function resolveIssuedXmlArchive',
        'export async function GET',
      ),
      'readArchivedXmlCopy(',
      "archive.state !== 'missing'",
      'ensureZugferdArchive(',
      'readArchivedXmlCopy(',
    );
    expect(xrechnungRoute).toContain('streamObject(archive.bucket, archive.key)');
  });

  it('recheckt eine DRAFT-XRechnung nach dem Rendern unter dem Archiv-Lock', () => {
    expectOrdered(
      section(xrechnungRoute, 'async function recheckDraftXmlPreview', 'type ReadyXmlArchive'),
      'lockInvoiceArchiveTx(',
      'tx.invoice.findFirst(',
      "fresh.status === 'CANCELLED'",
      'archivePointerChanged',
      "fresh.status !== 'DRAFT'",
      'fresh.updatedAt.getTime()',
    );
  });

  it('serialisiert das Lesen einer ausgestellten XRechnung vor Status und Dokument-Lookup', () => {
    const archivedRead = section(
      xrechnungRoute,
      'async function readArchivedXmlCopy',
      'export async function GET',
    );
    expectOrdered(
      archivedRead,
      'lockInvoiceArchiveTx(',
      'tx.invoice.findFirst(',
      "fresh.status === 'CANCELLED'",
      'const existing = fresh.xrechnungDocument',
      'const version = existing?.versions[0]',
    );
    expect(archivedRead).not.toContain('tx.document.findFirst(');
    expect(archivedRead).not.toContain('title:');
  });
});
