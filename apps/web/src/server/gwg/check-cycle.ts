// =============================================================================
// GwG-Prüfzyklus: neuen Snapshot öffnen und Risikobewertung speichern
// (Review-Befund K-03, vormals Callbacks in
// app/staff/(protected)/clients/[id]/gwg/actions.ts).
//
// Fachkatalog: GWG-REVERIFICATION-VALIDITY-001, GWG-RISK-REVIEW-001.
// Sperrordnung, Prüfungen, Schreibzugriffe und Audit-Ereignisse entsprechen
// unverändert der früheren Action; die Reihenfolge prüft
// server/gwg/__tests__/lifecycle-lock-call-sites.test.ts.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { cancelOpenGwgInvitesTx } from '@/server/gwg-onboarding/invite-lifecycle';
import { resolveGwgCheckNotificationsTx } from './check-decisions';
import { withEditableGwgCheckTx, type GwgStaffActor } from './editable-check';
import {
  copyGwgSnapshotTx,
  GWG_SNAPSHOT_COPY_INCLUDE,
  lockGwgCheckLifecycleTx,
  startFreshGwgReviewTx,
} from './reverification';
import { gwgRiskRevision } from './revisions';
import { computeRiskScore } from './risk-score';

const TERMINAL_GWG_STATUSES = ['VERIFIED', 'REJECTED', 'EXPIRED'] as const;

export interface GwgCheckCycleInput {
  clientId: string;
  /** Leer bei der Erstprüfung; sonst die zuletzt angezeigte, abgeschlossene Prüfung. */
  expectedLatestCheckId: string;
  changeScope: 'ROUTINE' | 'BENEFICIAL_OWNERS' | 'REPRESENTATIVES' | 'BOTH';
}

/** Ein neuer Zyklus folgt nur auf die erwartete, abgeschlossene Prüfung (Doppelklickschutz). */
function assertCycleStartable(
  latest: { id: string; status: string } | null,
  expectedLatestCheckId: string,
): void {
  if (expectedLatestCheckId) {
    if (!latest || latest.id !== expectedLatestCheckId) {
      throw new ActionError(
        'Der Prüfstatus hat sich zwischenzeitlich geändert. Bitte Seite neu laden.',
      );
    }
    if (!(TERMINAL_GWG_STATUSES as readonly string[]).includes(latest.status)) {
      throw new ActionError('Für diesen Mandanten läuft bereits eine bearbeitbare GwG-Prüfung.');
    }
  } else if (latest) {
    throw new ActionError(
      'Für diesen Mandanten existiert bereits eine GwG-Prüfung. Bitte Seite neu laden.',
    );
  }
}

/**
 * Öffnet einen neuen, zeitlich neuesten Prüfsnapshot (Erstanlage, Korrektur-
 * oder Wiederholungsprüfung) und übernimmt die Identifizierungsgrundlage
 * eines unveränderten Terminal-Snapshots.
 */
export async function startGwgCheckCycleTx(
  tx: TxClient,
  input: GwgCheckCycleInput,
  actor: GwgStaffActor,
): Promise<{ checkId: string }> {
  const { tenantId, staffId } = actor;
  const { clientId, expectedLatestCheckId } = input;
  await assertClientAccessTx(tx, actor.session, clientId);
  await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
  const latest = await tx.gwgCheck.findFirst({
    where: { clientId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: GWG_SNAPSHOT_COPY_INCLUDE,
  });
  assertCycleStartable(latest, expectedLatestCheckId);
  const changeScope = latest ? input.changeScope : 'INITIAL';

  // Immer einen zeitlich neuesten Snapshot erzeugen. Der gemeinsame
  // Lifecycle-Lock verhindert Doppelklick-Duplikate; ein bisher VERIFIEDer
  // Check wird dabei fachlich korrekt EXPIRED und der Mandant bis zur neuen
  // Freigabe fail-closed deaktiviert.
  const review = await startFreshGwgReviewTx(tx, {
    tenantId,
    clientId,
    predecessorCheckId: latest?.id ?? null,
    changeScope,
  });
  const checkId = review.reviewCheckId;
  if (latest) {
    await resolveGwgCheckNotificationsTx(tx, {
      tenantId,
      checkId: latest.id,
    });
  }
  await cancelOpenGwgInvitesTx(tx, {
    tenantId,
    clientId,
    cancelledByStaff: staffId,
  });

  const copiedSnapshot = await copyGwgSnapshotTx(tx, {
    tenantId,
    clientId,
    targetCheckId: checkId,
    source: latest,
  });

  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'gwg.check.open',
    resourceType: 'gwg_check',
    resourceId: checkId,
    after: {
      clientId,
      previousCheckId: latest?.id ?? null,
      previousStatus: latest?.status ?? null,
      sourceDestroyed: latest?.destroyedAt !== null && latest?.destroyedAt !== undefined,
      ...copiedSnapshot,
      invalidatedChecks: review.invalidatedChecks,
      clientDeactivated: review.clientDeactivated,
      changeScope,
    },
  });
  return { checkId };
}

export interface GwgRiskAnswersInput {
  checkId: string;
  clientId: string;
  answers: Record<string, number>;
  expectedRevision: string;
}

/**
 * Speichert die Risikobewertung (GWG-RISK-REVIEW-001). Status-CAS,
 * Rücknahme einer laufenden Freigabe und Bewertung in einem Statement.
 */
export async function saveRiskAnswersTx(
  tx: TxClient,
  input: GwgRiskAnswersInput,
  actor: GwgStaffActor,
): Promise<{ reviewReset: boolean; revision: string }> {
  const { checkId, clientId, answers } = input;
  const result = computeRiskScore(answers);
  return withEditableGwgCheckTx(
    tx,
    actor,
    {
      clientId,
      checkId,
      // Schmaler Select: die Zeile trägt große JSON-Spalten (Snapshots,
      // Breakdown), gebraucht werden nur Status + Risikofelder für CAS/Evidence.
      select: { status: true, riskAnswers: true, riskScore: true, riskLevel: true },
    },
    async (before) => {
      if (gwgRiskRevision(before) !== input.expectedRevision) {
        throw new ActionError(
          'Die Risikobewertung wurde zwischenzeitlich geändert. Bitte Seite neu laden; Ihre Eingabe wurde nicht überschrieben.',
        );
      }
      // Status-CAS und fachliches Update in einem Statement. Der alte Pfad
      // schrieb zuerst nur den Review-Reset und danach die Bewertung; auf der
      // bewusst serialisierten Tenant-Tx war das ein kompletter DB-Roundtrip
      // mehr pro Klick.
      const updated = await tx.gwgCheck.updateMany({
        where: { id: checkId, clientId, status: before.status },
        data: {
          status: 'DRAFT',
          reviewSubmittedAt: null,
          reviewSubmittedBy: null,
          riskAnswers: answers,
          riskScore: result.score,
          riskLevel: result.level,
          riskBreakdown: { factors: result.breakdown } as unknown as Prisma.InputJsonValue,
        },
      });
      if (updated.count === 0) {
        throw new ActionError(
          'Der Prüfstatus wurde parallel geändert. Ihre Eingabe wurde nicht gespeichert; bitte Seite neu laden.',
        );
      }
      await evidenceService.record(tx, {
        tenantId: actor.tenantId,
        actorType: 'STAFF',
        actorId: actor.staffId,
        action: 'gwg.check.assess',
        resourceType: 'gwg_check',
        resourceId: checkId,
        before: { riskScore: before.riskScore, riskLevel: before.riskLevel },
        after: { riskScore: result.score, riskLevel: result.level },
      });
      return {
        reviewReset: before.status === 'IN_REVIEW',
        revision: gwgRiskRevision({
          riskAnswers: answers,
          riskScore: result.score,
          riskLevel: result.level,
        }),
      };
    },
  );
}
