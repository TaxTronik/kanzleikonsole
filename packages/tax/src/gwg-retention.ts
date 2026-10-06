// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
// =============================================================================
// GwG § 8 Abs. 4 — Fristlogik der Löschprüfung (gemeinsam für Web und Worker)
//
// Satz 1 schreibt grundsätzlich fünf Jahre Aufbewahrung vor, soweit nicht eine
// andere gesetzliche Bestimmung eine längere Frist verlangt. Satz 2 ordnet in
// jedem Fall die Vernichtung spätestens nach zehn Jahren an. Diese Anwendung
// bildet keine zusätzliche Rechtsgrundlage ab und führt deshalb nach Ablauf der
// regulären Fünfjahresfrist eine manuelle Löschprüfung durch
// (DSGVO Art. 5 Abs. 1 lit. e).
//
// Das Object-Lock-Retain-Until setzt die Frist ab DOKUMENTERSTELLUNG (5 J.) —
// das verhindert nur zu FRÜHE Löschung. Der gesetzliche Fristbeginn knüpft bei
// bestehenden Beziehungen an deren Ende, sonst an die jeweilige Feststellung.
// Auch die absolute Zehnjahresgrenze läuft erst ab diesem maßgeblichen Start;
// das bloße Alter eines Belegs beendet keine laufende Geschäftsbeziehung.
//
// R-02: Vormals in apps/web/src/server/gwg/retention.ts (Referenz) und als
// nur per Kommentar synchron gehaltene Zähl-Kopie im Worker
// (jobs/gwg-expiry-check.ts). Hier liegen die reinen Fristprädikate und die
// Datenbankfilter; die Review-Queue-Abfragen (Fristlogik in JS) bleiben in der
// Web-App. Rein funktional, Prisma nur als Typ (Muster dieses Pakets).
// =============================================================================

import type { Prisma } from '@prisma/client';

export const GWG_RETENTION_YEARS = 5;
export const GWG_MAX_RETENTION_YEARS = 10;

/** Prüfstatus einer nie zu einer Geschäftsbeziehung gewordenen Erstprüfung. */
export const GWG_UNESTABLISHED_CHECK_STATUSES = [
  'DRAFT',
  'IN_REVIEW',
  'REJECTED',
  'EXPIRED',
] as const;

/**
 * Stichtag, ab dem die GwG-Belege eines beendeten Mandats zu löschen sind.
 * Frist beginnt am Jahresende des Mandatsende-Jahres + 5 Jahre → fällig ab dem
 * 1. Januar des Jahres danach (analog gobdRetentionUntil).
 * mandateEnd 2026-03-15 → Frist 2026-12-31 … 2031-12-31 → fällig ab 2032-01-01.
 */
export function gwgDeletionDeadline(mandateEndedAt: Date): Date {
  return new Date(Date.UTC(mandateEndedAt.getUTCFullYear() + GWG_RETENTION_YEARS + 1, 0, 1));
}

/** Absolute Vernichtungsgrenze ab dem maßgeblichen Fristbeginn (§ 8 Abs. 4 GwG). */
export function gwgMaximumDeletionDeadline(retentionStartedAt: Date): Date {
  return new Date(
    Date.UTC(retentionStartedAt.getUTCFullYear() + GWG_MAX_RETENTION_YEARS + 1, 0, 1),
  );
}

/** True, wenn die GwG-Belege des Mandats (zum Zeitpunkt `now`) löschreif sind. */
export function isGwgDeletionDue(
  mandateEndedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
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
  verifiedAt: Date | null | undefined = null,
  relationshipEstablished = false,
): Date | null {
  if (mandateEndedAt) return mandateEndedAt;
  // Bei einer bereits zustande gekommenen Geschäftsbeziehung beginnt die
  // reguläre Fünfjahresfrist erst mit deren Ende. Für eine nie abgeschlossene
  // Erstprüfung greift dagegen der „übrige Fall": Ende des Jahres der
  // Feststellung — auch wenn ein DRAFT/IN_REVIEW fachlich liegen blieb.
  if (relationshipEstablished || verifiedAt) return null;
  if (
    (GWG_UNESTABLISHED_CHECK_STATUSES as readonly string[]).includes(checkStatus) &&
    feststellungAt
  ) {
    return feststellungAt;
  }
  return null;
}

interface GwgRetentionCheckContext {
  status: string;
  createdAt: Date;
  verifiedAt: Date | null;
}

export interface GwgDocumentRetentionContext {
  createdAt: Date;
  mandateEndedAt: Date | null;
  relationshipEstablished?: boolean;
  linkedChecks: GwgRetentionCheckContext[];
  invite: {
    status: string;
    expiresAt: Date;
    cancelledAt: Date | null;
    gwgCheck: GwgRetentionCheckContext | null;
  } | null;
}

/**
 * Fristbeginn eines GwG-Dateibelegs. Neben dem normalen Mandatsende werden
 * auch Onboardings erfasst, bei denen nie eine Geschäftsbeziehung zustande kam:
 * abgebrochen, abgelaufen oder fachlich abgelehnt. Ein lediglich abgelaufener,
 * zuvor VERIFIED Check einer laufenden Beziehung ist dagegen KEIN Löschgrund.
 */
export function gwgDocumentEffectiveStart(
  context: GwgDocumentRetentionContext,
  now: Date = new Date(),
): Date | null {
  if (context.mandateEndedAt) return context.mandateEndedAt;
  if (context.relationshipEstablished) return null;
  const invite = context.invite;
  const referencedChecks = [
    ...context.linkedChecks,
    ...(invite?.gwgCheck ? [invite.gwgCheck] : []),
  ];
  // Derselbe Beleg kann in einer späteren Wiederholungsprüfung erneut genutzt
  // werden. Sobald ein verknüpfter Check verifiziert wurde, gehört er zu einer
  // zustande gekommenen Beziehung; deren reguläre Frist wartet auf das Ende.
  if (referencedChecks.some((check) => check.status === 'VERIFIED' || check.verifiedAt !== null)) {
    return null;
  }
  // Ohne jemals verifizierte Beziehung beginnt die Frist mit der Feststellung,
  // nicht erst mit einem späteren Statuswechsel. `now` bleibt aus API-
  // Kompatibilität Teil der Signatur; der absolute Ablauf wird separat
  // berücksichtigt.
  void now;
  return context.createdAt;
}

/**
 * Erster Fristbeginn, der zum Zeitpunkt `now` NICHT mehr löschreif ist:
 * gwgDeletionDeadline(start) <= now  ⇔  start < 1.1.(Jahr(now) − 5) (UTC).
 */
export function gwgDeletionDueStartCutoff(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear() - GWG_RETENTION_YEARS, 0, 1));
}

const VERIFIED_GWG_CHECK: Prisma.GwgCheckWhereInput = {
  OR: [{ status: 'VERIFIED' }, { verifiedAt: { not: null } }],
};

/**
 * P-21: dieselbe Auswahl wie findDueGwgDeletionDocs als Datenbankfilter, damit
 * Kacheln und der Worker zählen können, ohne alle Belege zu laden. Bildet
 * gwgDocumentEffectiveStart + gwgDeletionDeadline exakt nach (Gleichheit prüft
 * gwg-retention-count.test.ts gegen PostgreSQL): Fristbeginn ist das
 * Mandatsende, sonst — ohne zustande gekommene Beziehung und ohne verifizierten
 * verknüpften Check — die Erfassung des Belegs.
 */
export function dueGwgDeletionDocsWhere(now: Date = new Date()): Prisma.DocumentWhereInput {
  const cutoff = gwgDeletionDueStartCutoff(now);
  return {
    classification: 'GWG_EVIDENCE',
    deletedAt: null,
    OR: [
      { client: { is: { mandateEndedAt: { lt: cutoff } } } },
      {
        createdAt: { lt: cutoff },
        client: { is: { mandateEndedAt: null, allowActive: false, onboardingCompletedAt: null } },
        gwgIdDocuments: { none: { check: { is: VERIFIED_GWG_CHECK } } },
        NOT: { gwgOnboardingInvite: { is: { gwgCheck: { is: VERIFIED_GWG_CHECK } } } },
      },
    ],
  };
}

/**
 * Dieselbe Auswahl wie findDueGwgCheckDeletions (Review-Queue der
 * strukturierten Aufzeichnungen) als reiner Datenbankfilter. Fristbeginn ist
 * das Mandatsende, sonst bei nie zustande gekommener Beziehung die späteste
 * Feststellung (Check, Ausweisdokumente, wirtschaftlich Berechtigte,
 * Einladungen) — `none … gte cutoff` entspricht max(…) < cutoff. Gleichheit
 * mit der JS-Fristlogik prüft gwg-retention-count.test.ts gegen PostgreSQL.
 */
export function dueGwgCheckDeletionsWhere(now: Date = new Date()): Prisma.GwgCheckWhereInput {
  const cutoff = gwgDeletionDueStartCutoff(now);
  return {
    destroyedAt: null,
    OR: [
      { client: { mandateEndedAt: { lt: cutoff } } },
      {
        client: { mandateEndedAt: null, allowActive: false, onboardingCompletedAt: null },
        verifiedAt: null,
        updatedAt: { lt: cutoff },
        idDocuments: { none: { createdAt: { gte: cutoff } } },
        beneficialOwners: { none: { createdAt: { gte: cutoff } } },
        onboardingInvites: { none: { updatedAt: { gte: cutoff } } },
        status: { in: [...GWG_UNESTABLISHED_CHECK_STATUSES] },
      },
    ],
  };
}
