// =============================================================================
// DSGVO Art. 17 / Art. 5 Abs. 1 lit. e — Mandanten-Anonymisierung nach
// Mandatsende und Ablauf ALLER Aufbewahrungsfristen.
//
// Personenbezogene Stammdaten natürlicher Personen (client.kind = NATPERS)
// dürfen nicht unbegrenzt aufbewahrt werden. Solange gesetzliche Fristen
// laufen, hat die Aufbewahrungspflicht Vorrang (Art. 17 Abs. 3 lit. b):
//   - GoBD/§ 147 AO: 10 Jahre ab Schluss des Kalenderjahres
//   - GwG § 8 Abs. 4: 5 Jahre ab Schluss des Kalenderjahres des Mandatsendes
// Die LÄNGSTE Frist gewinnt → 10 Jahre ab Jahresende des Mandatsendes. Danach
// entfällt die Rechtsgrundlage und die Stammdaten sind zu anonymisieren.
//
// Diese Datei liefert die reine Fristlogik + die Such-Query für die
// Review-Queue (/staff/admin/dsgvo-retention); die eigentliche Anonymisierung
// bestätigt der Berufsträger — kein stilles Auto-Anonymisieren von Mandanten.
// Fristmechanik analog server/gwg/retention.ts (Jahresende-Rundung).
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { GWG_RETENTION_YEARS } from '@/server/gwg/retention';

/** GoBD/§ 147 AO: 10 Jahre ab Schluss des Kalenderjahres. */
export const GOBD_RETENTION_YEARS = 10;

/**
 * Wartefrist bis zur Mandanten-Anonymisierung: die längste der gesetzlichen
 * Aufbewahrungsfristen (GoBD 10 J. > GwG 5 J.).
 */
export const CLIENT_ANONYMIZATION_YEARS = Math.max(GOBD_RETENTION_YEARS, GWG_RETENTION_YEARS);

/**
 * Stichtag, ab dem die Stammdaten eines beendeten Mandats anonymisierbar sind.
 * Frist beginnt am Jahresende des Mandatsende-Jahres + 10 Jahre → fällig ab dem
 * 1. Januar des Jahres danach (analog gwgDeletionDeadline).
 * mandateEnd 2026-03-15 → Frist 2026-12-31 … 2036-12-31 → fällig ab 2037-01-01.
 */
export function clientAnonymizationDeadline(mandateEndedAt: Date): Date {
  return new Date(Date.UTC(mandateEndedAt.getUTCFullYear() + CLIENT_ANONYMIZATION_YEARS + 1, 0, 1));
}

/** True, wenn die Stammdaten des Mandats (zum Zeitpunkt `now`) anonymisierungsreif sind. */
export function isClientAnonymizationDue(
  mandateEndedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!mandateEndedAt) return false;
  return now.getTime() >= clientAnonymizationDeadline(mandateEndedAt).getTime();
}

export interface ClientAnonymizationItem {
  clientId: string;
  clientName: string;
  mandateEndedAt: Date;
  anonymizationDeadline: Date;
  /** Verknüpfte Kontakte — werden mit-anonymisiert. */
  contacts: number;
  /** Noch nicht vernichtete GwG-Belege + -Aufzeichnungen des Mandanten — die
   *  Anonymisierung ist erst zulässig, wenn die GwG-Queue abgearbeitet ist. */
  openGwgItems: number;
}

/**
 * Liefert die natürlichen Personen (NATPERS), deren Anonymisierungsfrist
 * abgelaufen ist und die noch nicht anonymisiert wurden (Review-Queue).
 * SQL-Vorfilter über das Jahr, exakte Prüfung via isClientAnonymizationDue.
 * `tx` wird übergeben → kein Modul-Level-DB-Import (testbar).
 */
export async function findDueClientAnonymizations(
  tx: TxClient,
  now: Date = new Date(),
): Promise<ClientAnonymizationItem[]> {
  // Grobfilter: Mandat endete vor dem 1.1. des Jahres (now - 10). Die exakte
  // Jahresende-Rundung macht isClientAnonymizationDue.
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - CLIENT_ANONYMIZATION_YEARS, 0, 1));
  const clients = await tx.client.findMany({
    where: { kind: 'NATPERS', anonymizedAt: null, mandateEndedAt: { lt: cutoff } },
    select: {
      id: true,
      name: true,
      mandateEndedAt: true,
      _count: {
        select: {
          contacts: true,
          documents: { where: { classification: 'GWG_EVIDENCE', deletedAt: null } },
          gwgChecks: { where: { destroyedAt: null } },
        },
      },
    },
    orderBy: { mandateEndedAt: 'asc' },
  });

  const out: ClientAnonymizationItem[] = [];
  for (const c of clients) {
    if (!c.mandateEndedAt || !isClientAnonymizationDue(c.mandateEndedAt, now)) continue;
    out.push({
      clientId: c.id,
      clientName: c.name,
      mandateEndedAt: c.mandateEndedAt,
      anonymizationDeadline: clientAnonymizationDeadline(c.mandateEndedAt),
      contacts: c._count.contacts,
      openGwgItems: c._count.documents + c._count.gwgChecks,
    });
  }
  return out;
}
