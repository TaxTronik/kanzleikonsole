// =============================================================================
// Rechnungsnummern + Status-Lebenszyklus (GoB, iter85).
//
// Nummernvergabe: automatisch und lückenlos je Tenant+Jahr (YYYY-NNNN) über
// die Sequenztabelle invoice_number_seq. Die Vergabe läuft IN der Anlage-
// Transaktion unter einem Advisory-Lock — schlägt der INSERT fehl, rollt die
// Sequenz mit zurück, es entsteht keine Lücke. Storno erzeugt keine Lücke
// (CANCELLED behält die Nummer und erklärt sie). Auch ein Entwurf erhält
// bereits seine endgültige Nummer; auf App-Ebene gibt es KEINE Lösch-Aktion
// für Rechnungen (Entwürfe werden storniert, nicht gelöscht), sodass keine
// vergebene Nummer verschwindet. Der DELETE-für-DRAFT-Trigger ist reiner
// Backstop (Cascade/DB-Wartung) und keine reguläre Nutzeroperation.
// EXTERNAL-Rechnungen tragen die Nummer des Fremdsystems und gehen an der
// Sequenz vorbei; ihr Format ist gegen das reservierte YYYY-NNNN-Muster
// abgegrenzt (UploadExternalSchema), damit sie keinen Sequenz-Slot belegen.
//
// Statusübergänge: identische Matrix wie der DB-Trigger invoice_protect_update
// (Backstop) — hier für verständliche Fehlermeldungen VOR dem DB-Roundtrip.
// =============================================================================

import type { InvoiceStatus, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Nummernformat des automatischen Nummernkreises. */
export function formatInvoiceNumber(year: number, no: number): string {
  return `${year}-${String(no).padStart(4, '0')}`;
}

/**
 * Vergibt die nächste Rechnungsnummer des Tenant-Jahres — atomar, lückenlos.
 * MUSS in derselben Transaktion wie der invoice-INSERT laufen.
 *
 * Erstvergabe eines Jahres initialisiert die Sequenz aus dem MAX bestehender
 * `YYYY-N`-Nummern (Bestandsdaten aus der manuellen Vergabe kollidieren so
 * nicht). Der Advisory-Lock serialisiert konkurrierende Anlagen desselben
 * Tenant-Jahres; er ist transaktionsgebunden (xact) und löst sich von selbst.
 */
export async function allocateInvoiceNumber(
  tx: Tx,
  tenantId: string,
  issueDate: Date,
): Promise<string> {
  const year = issueDate.getUTCFullYear();
  const yearPrefix = `^${year}-(\\d+)$`;

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'invoice-no:' + tenantId + ':' + year}, 0))`;

  await tx.$executeRaw`
    INSERT INTO "invoice_number_seq" (tenant_id, year, last_no)
    VALUES (
      ${tenantId}::uuid,
      ${year},
      COALESCE((
        SELECT MAX((substring(number from ${yearPrefix}))::int)
        FROM "invoice"
        WHERE tenant_id = ${tenantId}::uuid AND number ~ ${yearPrefix}
      ), 0)
    )
    ON CONFLICT (tenant_id, year) DO NOTHING`;

  const rows = await tx.$queryRaw<Array<{ last_no: number }>>`
    UPDATE "invoice_number_seq"
    SET last_no = last_no + 1
    WHERE tenant_id = ${tenantId}::uuid AND year = ${year}
    RETURNING last_no`;

  const no = rows[0]?.last_no;
  if (!no) throw new Error('Rechnungsnummern-Vergabe fehlgeschlagen (Sequenz nicht verfügbar).');
  return formatInvoiceNumber(year, no);
}

/** Erlaubte Statusübergänge — MUSS der Matrix des DB-Triggers entsprechen. */
const TRANSITIONS: Record<InvoiceStatus, ReadonlyArray<InvoiceStatus>> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['PAID', 'OVERDUE', 'CANCELLED'],
  OVERDUE: ['PAID', 'CANCELLED'],
  PAID: [],
  CANCELLED: [],
};

export function isValidInvoiceTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
