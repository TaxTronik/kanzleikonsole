// =============================================================================
// GwG § 8 Abs. 4 — Pflichtlöschung nach Fristablauf
//
// Satz: „Die Aufzeichnungen und sonstigen Belege sind fünf Jahre aufzubewahren.
// Die Aufbewahrungsfrist … beginnt mit dem Schluss des Kalenderjahres, in dem
// die Geschäftsbeziehung endet." Satz 4 verlangt EXPLIZIT die „unverzügliche
// Vernichtung" nach Ablauf — Über-Aufbewahrung ist ein Datenschutzverstoß
// (DSGVO Art. 5 Abs. 1 lit. e), nicht nur unnötig.
//
// Das Object-Lock-Retain-Until setzt die Frist ab DOKUMENTERSTELLUNG (5 J.) —
// das verhindert nur zu FRÜHE Löschung. Die gesetzliche LÖSCH-Pflicht knüpft an
// das Mandatsende. Diese Datei liefert die reine Fristlogik + die Such-Query für
// die Review-Queue; die eigentliche Vernichtung bestätigt der Berufsträger
// (Review-Queue), kein stilles Auto-Delete von Rechtsbelegen.
// =============================================================================

import type { TxClient } from '@taxtronik/db';

export const GWG_RETENTION_YEARS = 5;

/**
 * Stichtag, ab dem die GwG-Belege eines beendeten Mandats zu löschen sind.
 * Frist beginnt am Jahresende des Mandatsende-Jahres + 5 Jahre → fällig ab dem
 * 1. Januar des Jahres danach (analog gobdRetentionUntil).
 * mandateEnd 2026-03-15 → Frist 2026-12-31 … 2031-12-31 → fällig ab 2032-01-01.
 */
export function gwgDeletionDeadline(mandateEndedAt: Date): Date {
  return new Date(Date.UTC(mandateEndedAt.getUTCFullYear() + GWG_RETENTION_YEARS + 1, 0, 1));
}

/** True, wenn die GwG-Belege des Mandats (zum Zeitpunkt `now`) löschreif sind. */
export function isGwgDeletionDue(mandateEndedAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!mandateEndedAt) return false;
  return now.getTime() >= gwgDeletionDeadline(mandateEndedAt).getTime();
}

export interface GwgDeletionItem {
  documentId: string;
  clientId: string;
  clientName: string;
  title: string;
  mandateEndedAt: Date;
  deletionDeadline: Date;
}

/**
 * Liefert die GwG-Beweisdokumente, deren gesetzliche Löschfrist abgelaufen ist
 * (Review-Queue). SQL-Vorfilter über das Jahr, exakte Prüfung via
 * isGwgDeletionDue. `tx` wird übergeben → kein Modul-Level-DB-Import (testbar).
 */
export async function findDueGwgDeletionDocs(tx: TxClient, now: Date = new Date()): Promise<GwgDeletionItem[]> {
  // Grobfilter: Mandat endete vor dem 1.1. des Jahres (now - 5). Die exakte
  // Jahresende-Rundung macht isGwgDeletionDue.
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - GWG_RETENTION_YEARS, 0, 1));
  const clients = await tx.client.findMany({
    where: { mandateEndedAt: { lt: cutoff } },
    select: {
      id: true,
      name: true,
      mandateEndedAt: true,
      documents: {
        where: { classification: 'GWG_EVIDENCE', deletedAt: null },
        select: { id: true, title: true },
      },
    },
  });

  const out: GwgDeletionItem[] = [];
  for (const c of clients) {
    if (!c.mandateEndedAt || !isGwgDeletionDue(c.mandateEndedAt, now)) continue;
    const deadline = gwgDeletionDeadline(c.mandateEndedAt);
    for (const d of c.documents) {
      out.push({
        documentId: d.id,
        clientId: c.id,
        clientName: c.name,
        title: d.title,
        mandateEndedAt: c.mandateEndedAt,
        deletionDeadline: deadline,
      });
    }
  }
  return out;
}
