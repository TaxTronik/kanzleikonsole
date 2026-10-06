// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
// =============================================================================
// GwG § 8 Abs. 4 — Review-Queue der Löschprüfung (Belege und Aufzeichnungen)
//
// K-01: vormals apps/web/src/server/gwg/retention.ts (die Web-App re-exportiert
// von dort). Die exakte reguläre und absolute Fristprüfung läuft in JS mit den
// Prädikaten aus retention.ts; deren COUNT-Filter (Admin-Kachel, Worker
// gwg-expiry-check) müssen genau diese Queue treffen
// (packages/db/src/__tests__/gwg-retention-count.test.ts). Die eigentliche
// Vernichtung bestätigt der Berufsträger (kein stilles Auto-Delete von
// Rechtsbelegen). Der Aufrufer reicht seine Tenant-Transaktion herein (RLS
// begrenzt auf den aktuellen Tenant).
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import {
  dueGwgDeletionDocsWhere,
  GWG_UNESTABLISHED_CHECK_STATUSES,
  gwgDeletionDeadline,
  gwgDeletionDueStartCutoff,
  gwgDocumentEffectiveStart,
  gwgEffectiveStart,
  gwgMaximumDeletionDeadline,
} from './retention';

/** Anzahl der löschreifen GwG-Belege (Admin-Kachel) per COUNT statt Volllast. */
export async function countDueGwgDeletionDocs(
  tx: TxClient,
  now: Date = new Date(),
): Promise<number> {
  return tx.document.count({ where: dueGwgDeletionDocsWhere(now) });
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
  const cutoff = gwgDeletionDueStartCutoff(now);
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
          status: { in: [...GWG_UNESTABLISHED_CHECK_STATUSES] },
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
