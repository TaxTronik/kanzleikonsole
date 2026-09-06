import { withTenantContext, type TenantContext, type TxClient } from '@taxtronik/db';
import {
  screenEu,
  sourceIsFresh,
  validateScreeningSubject,
  type ScreeningSubject,
  type SanctionEntry,
} from '@taxtronik/tax';
import { fetchEuSanctions } from '@taxtronik/tax/screening/source';
import { screeningJson, storeSanctionsSnapshot } from '@taxtronik/tax/screening/persistence';
import { evidenceService } from '@/server/container';
import { ActionError } from '@/server/actions/staff-action';
import { bindScreeningSubjectTx } from './gwg-gate';

export async function refreshEuSource(ctx: TenantContext) {
  try {
    const downloaded = await fetchEuSanctions();
    return await withTenantContext(ctx, async (tx) => {
      const saved = await storeSanctionsSnapshot(tx, ctx.tenantId, downloaded);
      await evidenceService.record(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        actorType: 'STAFF',
        action: 'screening.source.refresh',
        resourceType: 'sanctions_snapshot',
        resourceId: saved.snapshot.id,
        after: {
          sha256: downloaded.sha256,
          entryCount: downloaded.entries.length,
          changed: saved.changed,
        },
      });
      return { changed: saved.changed, entryCount: downloaded.entries.length };
    });
  } catch {
    await withTenantContext(ctx, async (tx) => {
      await tx.sanctionsSourceState.upsert({
        where: { tenantId: ctx.tenantId },
        create: {
          tenantId: ctx.tenantId,
          attemptedAt: new Date(),
          lastError:
            'Abruf oder Validierung fehlgeschlagen. Letzter gültiger Bestand bleibt erhalten.',
        },
        update: {
          attemptedAt: new Date(),
          lastError:
            'Abruf oder Validierung fehlgeschlagen. Letzter gültiger Bestand bleibt erhalten.',
        },
      });
    });
    throw new ActionError(
      'EU-Quelle konnte nicht sicher aktualisiert werden. Letzter gültiger Bestand bleibt erhalten; Quelle und Protokoll prüfen.',
    );
  }
}

export async function createEuRun(
  tx: TxClient,
  tenantId: string,
  staffId: string,
  clientId: string,
  subjectInput: ScreeningSubject & { targetKey?: string; contextHash?: string },
) {
  let subject: ScreeningSubject;
  try {
    subject = validateScreeningSubject(subjectInput);
  } catch (e) {
    throw new ActionError((e as Error).message);
  }
  const client = await tx.client.findFirst({
    where: { id: clientId, tenantId, anonymizedAt: null, mandateEndedAt: null },
    select: { id: true },
  });
  if (!client) throw new ActionError('Mandat ist beendet oder nicht verfügbar.');
  const state = await tx.sanctionsSourceState.findUnique({
    where: { tenantId },
    include: { snapshot: true },
  });
  if (!state?.snapshot || !sourceIsFresh(state.checkedAt, state.lastError))
    throw new ActionError(
      'Keine innerhalb von 48 Stunden erfolgreich geprüfte EU-Quelle. Administration muss die Quelle aktualisieren.',
    );
  const bound = await bindScreeningSubjectTx(tx, tenantId, clientId, {
    ...subject,
    ...(subjectInput.targetKey
      ? { targetKey: subjectInput.targetKey, contextHash: subjectInput.contextHash }
      : {}),
  });
  const result = screenEu(bound, state.snapshot.entries as unknown as SanctionEntry[]);
  const run = await tx.screeningRun.create({
    data: {
      tenantId,
      clientId,
      snapshotId: state.snapshotId,
      kind: 'EU',
      subject: screeningJson(bound),
      result: screeningJson(result),
      createdBy: staffId,
    },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorId: staffId,
    actorType: 'STAFF',
    action: 'screening.run.create',
    resourceType: 'screening_run',
    resourceId: run.id,
    after: {
      clientId,
      snapshotId: state.snapshotId,
      algorithm: result.algorithm,
      candidateCount: result.candidateCount,
    },
  });
  return run;
}
