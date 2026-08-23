// =============================================================================
// GwG § 8 Abs. 4 — Löschprüfung nach Fristablauf
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
// das bloße Alter eines Belegs beendet keine laufende Geschäftsbeziehung. Diese Datei liefert die reine
// Fristlogik + die Such-Query für die Review-Queue; die eigentliche Vernichtung
// bestätigt der Berufsträger (kein stilles Auto-Delete von Rechtsbelegen).
// =============================================================================

import type { TxClient } from '@taxtronik/db';

export const GWG_RETENTION_YEARS = 5;
export const GWG_MAX_RETENTION_YEARS = 10;

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
  if (['DRAFT', 'IN_REVIEW', 'REJECTED', 'EXPIRED'].includes(checkStatus) && feststellungAt) {
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
  // Kompatibilität Teil der Signatur; der absolute Ablauf wird unten separat
  // berücksichtigt.
  void now;
  return context.createdAt;
}

export interface GwgDeletionItem {
  documentId: string;
  clientId: string;
  clientName: string;
  title: string;
  retentionStartedAt: Date;
  retentionReason: 'MANDATE_ENDED' | 'ONBOARDING_TERMINATED' | 'MAXIMUM_RETENTION';
  deletionDeadline: Date;
  destructionPending: boolean;
}

/**
 * Liefert die GwG-Beweisdokumente, deren gesetzliche Löschfrist abgelaufen ist
 * (Review-Queue). Die exakte reguläre und absolute Fristprüfung läuft in JS.
 * `tx` wird übergeben → kein Modul-Level-DB-Import (testbar).
 */
export async function findDueGwgDeletionDocs(
  tx: TxClient,
  now: Date = new Date(),
): Promise<GwgDeletionItem[]> {
  // RLS begrenzt auf den aktuellen Tenant. Die exakte Fristlogik läuft in JS,
  // weil neben dem Mandatsende auch Invite-/Check-Zustände einfließen.
  const documents = await tx.document.findMany({
    where: { classification: 'GWG_EVIDENCE', deletedAt: null },
    select: {
      id: true,
      title: true,
      clientId: true,
      createdAt: true,
      gwgDestructionRequestedAt: true,
      client: {
        select: {
          name: true,
          mandateEndedAt: true,
          allowActive: true,
          onboardingCompletedAt: true,
        },
      },
      gwgIdDocuments: {
        select: {
          check: { select: { status: true, createdAt: true, verifiedAt: true } },
        },
      },
      gwgOnboardingInvite: {
        select: {
          status: true,
          expiresAt: true,
          cancelledAt: true,
          gwgCheck: {
            select: { status: true, createdAt: true, verifiedAt: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const out: GwgDeletionItem[] = [];
  for (const d of documents) {
    if (!d.clientId || !d.client) continue;
    const start = gwgDocumentEffectiveStart(
      {
        createdAt: d.createdAt,
        mandateEndedAt: d.client.mandateEndedAt,
        relationshipEstablished: d.client.allowActive || d.client.onboardingCompletedAt !== null,
        linkedChecks: d.gwgIdDocuments.map((idDocument) => idDocument.check),
        invite: d.gwgOnboardingInvite,
      },
      now,
    );
    // Bei laufender/etablierter Beziehung ohne Mandatsende hat die Frist noch
    // nicht begonnen. Das Dokumentalter allein ist ausdrücklich kein Ersatz.
    if (!start) continue;
    const regularDeadline = gwgDeletionDeadline(start);
    const maximumDeadline = gwgMaximumDeletionDeadline(start);
    if (now < regularDeadline) continue;
    // Ab fünf Jahren ist der Eintrag regulär prüffällig. Bleibt die manuelle
    // Review bis zur Höchstfrist offen, eskaliert die Darstellung ab zehn
    // Jahren sichtbar auf MAXIMUM_RETENTION.
    const maximumReached = now >= maximumDeadline;
    const deletionDeadline = maximumReached ? maximumDeadline : regularDeadline;
    out.push({
      documentId: d.id,
      clientId: d.clientId,
      clientName: d.client.name,
      title: d.title,
      retentionStartedAt: start,
      retentionReason: maximumReached
        ? 'MAXIMUM_RETENTION'
        : d.client.mandateEndedAt
          ? 'MANDATE_ENDED'
          : 'ONBOARDING_TERMINATED',
      deletionDeadline,
      destructionPending: d.gwgDestructionRequestedAt !== null,
    });
  }
  return out;
}

export interface GwgCheckDeletionItem {
  checkId: string;
  clientId: string;
  clientName: string;
  status: string;
  retentionStartedAt: Date;
  retentionReason: 'MANDATE_ENDED' | 'ONBOARDING_TERMINATED' | 'MAXIMUM_RETENTION';
  deletionDeadline: Date;
  /** Noch nicht vernichtete GWG_EVIDENCE-Dateien des Mandanten — die DB-
   *  Vernichtung ist erst zulässig, wenn die Datei-Belege weg sind. */
  openEvidenceDocs: number;
}

/**
 * § 8 Abs. 1 und 4 GwG erfasst die AUFZEICHNUNGEN ebenso wie Datei-Belege.
 * Liefert die GwG-Prüfungen (Aggregate: Check + wirtschaftlich
 * Berechtigte + Ausweisdokumente), deren Löschfrist abgelaufen ist und die noch
 * nicht vernichtet wurden (destroyedAt = null). Eigener Queue-Eintrag neben den
 * Datei-Belegen: erfasst auch Checks, deren Dateien bereits vernichtet sind
 * (der Datei-Confirm löscht das Document — der Check blieb vorher unbegrenzt).
 */
export async function findDueGwgCheckDeletions(
  tx: TxClient,
  now: Date = new Date(),
): Promise<GwgCheckDeletionItem[]> {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - GWG_RETENTION_YEARS, 0, 1));
  const checks = await tx.gwgCheck.findMany({
    where: {
      destroyedAt: null,
      OR: [
        // Beendetes Mandat: Frist ab Mandatsende.
        { client: { mandateEndedAt: { lt: cutoff } } },
        // Nie zustande gekommene, auch offen liegen gebliebene Erstprüfung:
        // Frist ab Feststellung.
        {
          client: {
            mandateEndedAt: null,
            allowActive: false,
            onboardingCompletedAt: null,
          },
          verifiedAt: null,
          status: { in: ['DRAFT', 'IN_REVIEW', 'REJECTED', 'EXPIRED'] },
          updatedAt: { lt: cutoff },
        },
      ],
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      verifiedAt: true,
      clientId: true,
      client: {
        select: {
          name: true,
          mandateEndedAt: true,
          allowActive: true,
          onboardingCompletedAt: true,
        },
      },
      idDocuments: {
        select: {
          createdAt: true,
          document: { select: { id: true, classification: true, gwgDestroyedAt: true } },
        },
      },
      beneficialOwners: { select: { createdAt: true } },
      onboardingInvites: {
        select: {
          // Teil der fachlichen Feststellung: Eine später aktualisierte
          // Einladung darf die DB-Backstop-Frist nicht jünger berechnen als
          // die Review-Queue.
          updatedAt: true,
          uploadedDocuments: {
            select: { id: true, classification: true, gwgDestroyedAt: true },
          },
        },
      },
    },
  });

  const out: GwgCheckDeletionItem[] = [];
  for (const check of checks) {
    const feststellungAt = [
      check.updatedAt,
      ...check.idDocuments.map((document) => document.createdAt),
      ...check.beneficialOwners.map((owner) => owner.createdAt),
      ...check.onboardingInvites.map((invite) => invite.updatedAt),
    ].reduce((latest, candidate) => (candidate.getTime() > latest.getTime() ? candidate : latest));
    const start = gwgEffectiveStart(
      check.client.mandateEndedAt,
      check.status,
      feststellungAt,
      check.verifiedAt,
      check.client.allowActive || check.client.onboardingCompletedAt !== null,
    );
    // Auch die Höchstfrist beginnt erst mit dem Beziehungsende bzw. — wenn nie
    // eine Beziehung zustande kam — mit dem Feststellungsjahr.
    if (!start) continue;
    const regularDeadline = gwgDeletionDeadline(start);
    const maximumDeadline = gwgMaximumDeletionDeadline(start);
    if (now < regularDeadline) continue;
    const maximumReached = now >= maximumDeadline;
    const deletionDeadline = maximumReached ? maximumDeadline : regularDeadline;

    const openDocumentIds = new Set<string>();
    for (const idDocument of check.idDocuments) {
      const document = idDocument.document;
      if (document?.classification === 'GWG_EVIDENCE' && !document.gwgDestroyedAt) {
        openDocumentIds.add(document.id);
      }
    }
    for (const invite of check.onboardingInvites) {
      for (const document of invite.uploadedDocuments) {
        if (document.classification === 'GWG_EVIDENCE' && !document.gwgDestroyedAt) {
          openDocumentIds.add(document.id);
        }
      }
    }

    out.push({
      checkId: check.id,
      clientId: check.clientId,
      clientName: check.client.name,
      status: check.status,
      retentionStartedAt: start,
      retentionReason: maximumReached
        ? 'MAXIMUM_RETENTION'
        : check.client.mandateEndedAt
          ? 'MANDATE_ENDED'
          : 'ONBOARDING_TERMINATED',
      deletionDeadline,
      openEvidenceDocs: openDocumentIds.size,
    });
  }
  return out;
}
