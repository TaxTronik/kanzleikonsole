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

/**
 * § 8 Abs. 4 S. 2 GwG: Der Fristbeginn ist das Ende der Geschäftsbeziehung.
 * Kam KEINE Geschäftsbeziehung zustande (Onboarding abgelehnt/abgelaufen,
 * Mandat nie aktiviert), beginnt die Frist mit dem Schluss des Kalenderjahres
 * der FESTSTELLUNG (Erfassung der Identifizierungsdaten). Sonst würden abgelehnte
 * Onboardings mit Ausweiskopien unbegrenzt gespeichert (DSGVO Art. 5 Abs. 1
 * lit. e). Liefert das maßgebliche Startdatum oder null (Frist läuft noch nicht:
 * aktives/offenes Mandat ohne Ende).
 */
export function gwgEffectiveStart(
  mandateEndedAt: Date | null | undefined,
  checkStatus: string,
  feststellungAt: Date | null | undefined,
): Date | null {
  if (mandateEndedAt) return mandateEndedAt;
  // Nur terminale Prüfungen ohne Mandat: eine offene (DRAFT/IN_REVIEW) oder
  // verifizierte Prüfung kann noch zu einer Geschäftsbeziehung führen.
  if ((checkStatus === 'REJECTED' || checkStatus === 'EXPIRED') && feststellungAt) {
    return feststellungAt;
  }
  return null;
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

export interface GwgCheckDeletionItem {
  checkId: string;
  clientId: string;
  clientName: string;
  status: string;
  mandateEndedAt: Date;
  deletionDeadline: Date;
  /** Noch nicht vernichtete GWG_EVIDENCE-Dateien des Mandanten — die DB-
   *  Vernichtung ist erst zulässig, wenn die Datei-Belege weg sind. */
  openEvidenceDocs: number;
}

/**
 * § 8 Abs. 4 S. 4 GwG verlangt die Vernichtung der AUFZEICHNUNGEN — nicht nur
 * der Datei-Belege. Liefert die GwG-Prüfungen (Aggregate: Check + wirtschaftlich
 * Berechtigte + Ausweisdokumente), deren Löschfrist abgelaufen ist und die noch
 * nicht vernichtet wurden (destroyedAt = null). Eigener Queue-Eintrag neben den
 * Datei-Belegen: erfasst auch Checks, deren Dateien bereits vernichtet sind
 * (der Datei-Confirm löscht das Document — der Check blieb vorher unbegrenzt).
 */
export async function findDueGwgCheckDeletions(tx: TxClient, now: Date = new Date()): Promise<GwgCheckDeletionItem[]> {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - GWG_RETENTION_YEARS, 0, 1));
  const clients = await tx.client.findMany({
    where: {
      gwgChecks: { some: { destroyedAt: null } },
      OR: [
        // Beendetes Mandat: Frist ab Mandatsende.
        { mandateEndedAt: { lt: cutoff } },
        // Nie zustande gekommen: terminale Prüfung, Frist ab Feststellung.
        {
          mandateEndedAt: null,
          gwgChecks: { some: { destroyedAt: null, status: { in: ['REJECTED', 'EXPIRED'] }, createdAt: { lt: cutoff } } },
        },
      ],
    },
    select: {
      id: true,
      name: true,
      mandateEndedAt: true,
      gwgChecks: {
        where: { destroyedAt: null },
        select: { id: true, status: true, createdAt: true },
      },
      _count: {
        select: { documents: { where: { classification: 'GWG_EVIDENCE', deletedAt: null } } },
      },
    },
  });

  const out: GwgCheckDeletionItem[] = [];
  for (const c of clients) {
    for (const check of c.gwgChecks) {
      const start = gwgEffectiveStart(c.mandateEndedAt, check.status, check.createdAt);
      if (!start || !isGwgDeletionDue(start, now)) continue;
      out.push({
        checkId: check.id,
        clientId: c.id,
        clientName: c.name,
        status: check.status,
        mandateEndedAt: start,
        deletionDeadline: gwgDeletionDeadline(start),
        openEvidenceDocs: c._count.documents,
      });
    }
  }
  return out;
}
