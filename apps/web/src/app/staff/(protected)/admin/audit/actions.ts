'use server';

import { redirect } from 'next/navigation';
import { withTenantContext } from '@taxtronik/db';
import {
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY,
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  type PersistedRecoveryCheckpoint,
  type PersistedVerifyResult,
} from '@taxtronik/evidence';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';
import { evidenceService } from '@/server/container';
import { enqueueAuditVerify } from '@/server/jobs/audit-verify-queue';

/**
 * „Jetzt prüfen" — stößt die Chain-Verifikation als Hintergrund-Job an
 * (Worker: audit-verify-check, nur dieser Tenant). Die Seite zeigt danach das
 * persistierte Ergebnis; der Lauf selbst läuft NICHT mehr im Render-Pfad.
 */
export async function triggerAuditVerifyAction(): Promise<void> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) throw new ActionError(g.error);
  const { tenantId, staffId, ctx } = g;

  // Zeitstempel VOR dem Enqueue: das Polling gilt als fertig, sobald ein
  // persistiertes Ergebnis NEUER als dieser Moment vorliegt (unabhängig von der
  // requestId). Das überlebt ein Überschreiben durch den nächtlichen Lauf oder
  // einen parallelen zweiten Trigger — sonst würde `done` nie true.
  const queuedAt = new Date().toISOString();
  const requestId = await enqueueAuditVerify(tenantId, staffId);

  // Manueller Trigger gehört in die Chain (analog audit.rotate.trigger) —
  // WER die Verifikation angestoßen hat, ist Teil der Rechenschaft.
  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'audit.verify.trigger',
      resourceType: 'audit_log',
      after: { triggeredManually: true },
    });
  });

  redirect(
    `/staff/admin/audit?verify=queued&requestId=${requestId}&queuedAt=${encodeURIComponent(queuedAt)}`,
  );
}

/**
 * Markiert eine bewusste Wiederaufnahme nach einem Chain-Bruch.
 *
 * Das repariert die Vergangenheit NICHT und macht den Gesamtstatus nicht grün.
 * Es setzt einen neuen, auditierten Checkpoint, ab dem eine Teilkette separat
 * verifiziert werden kann.
 */
export async function createAuditRecoveryCheckpointAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) throw new ActionError(g.error);
  const { tenantId, staffId, ctx } = g;
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 500) || null;

  await withTenantContext(ctx, async (tx) => {
    const verifyRow = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: AUDIT_VERIFY_RESULT_SETTING_KEY } },
    });
    const verifyResult = (verifyRow?.value ?? null) as PersistedVerifyResult | null;
    if (!verifyResult) {
      throw new ActionError('Noch kein Audit-Prüfergebnis vorhanden. Bitte zuerst prüfen.');
    }
    if (verifyResult.ok) {
      throw new ActionError('Die Hash-Chain ist aktuell intakt; ein Recovery-Checkpoint ist nicht nötig.');
    }

    const ev = await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'audit.recovery.checkpoint',
      resourceType: 'audit_log',
      resourceId: verifyResult.firstBreak?.auditId ?? 'recovery',
      after: {
        reason,
        firstBreak: verifyResult.firstBreak,
        sealBreaks: verifyResult.sealBreaks,
        policyBreaks: verifyResult.policyBreaks,
        error: verifyResult.error,
        statement:
          'Historischer Bruch bleibt bestehen; ab diesem Audit-Eintrag wird die Recovery-Teilkette separat geprüft.',
      },
    });

    const checkpoint: PersistedRecoveryCheckpoint = {
      auditId: String(ev.id),
      createdAt: ev.occurredAt.toISOString(),
      createdBy: staffId,
      reason,
      firstBreak: verifyResult.firstBreak,
      trustedPrevHash: ev.prevHash.toString('hex'),
      trustedThisHash: ev.thisHash.toString('hex'),
    };

    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY } },
      create: { tenantId, key: AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY, value: checkpoint as object, updatedBy: staffId },
      update: { value: checkpoint as object, updatedBy: staffId },
    });
  });

  const queuedAt = new Date().toISOString();
  const requestId = await enqueueAuditVerify(tenantId, staffId);
  redirect(
    `/staff/admin/audit?checkpoint=created&verify=queued&requestId=${requestId}&queuedAt=${encodeURIComponent(queuedAt)}`,
  );
}
