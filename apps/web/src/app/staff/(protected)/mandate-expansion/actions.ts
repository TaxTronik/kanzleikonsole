'use server';
import { z } from 'zod';
import { withStaff, staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { withTenantContext } from '@taxtronik/db';
import { toActionError } from '@/server/auth/rbac';
import { revalidatePath } from 'next/cache';
import { revokeAllSessions } from '@/server/auth/revocation';
import { saveStructureTx, changeDependencyTx } from '@/server/mandate-expansion/service';
import { prepareOffboardingTx, finishOffboardingTx } from '@/server/mandate-expansion/offboarding';
import { recordVdbStateTx } from '@/server/mandate-expansion/vdb';
import { VDB_STATES } from '@/server/mandate-expansion/model';
import { archiveStructure, archiveOffboarding } from '@/server/mandate-expansion/artifacts';
import { assignWorkflowYearTx } from '@/server/mandate-expansion/dependencies';

export async function assignWorkflowYearAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = z
    .object({
      instanceId: z.string().uuid(),
      year: z.coerce.number().int().min(1900).max(2200),
      expectedYear: z.coerce.number().int().nullable(),
    })
    .safeParse({
      instanceId: form.get('instanceId'),
      year: form.get('year'),
      expectedYear: form.get('expectedYear') || null,
    });
  if (!parsed.success) return { ok: false, error: 'Workflow und Veranlagungsjahr angeben.' };
  return withStaff(
    async (tx, { session }) => {
      await assignWorkflowYearTx(
        tx,
        session,
        parsed.data.instanceId,
        parsed.data.year,
        parsed.data.expectedYear,
      );
    },
    { module: 'workflowDependencies', revalidate: '/staff/mandate-expansion/dependencies' },
  );
}

export async function saveStructureAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get('structure')));
  } catch {
    return { ok: false, error: 'Ungültige Strukturdaten.' };
  }
  return withStaff(
    async (tx, { session }) => {
      await saveStructureTx(tx, session, raw);
    },
    { module: 'mandateStructure', revalidate: '/staff/mandate-expansion/structure' },
  );
}
export async function changeDependencyAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = z
    .object({ from: z.string().uuid(), to: z.string().uuid(), remove: z.boolean() })
    .safeParse({
      from: form.get('from'),
      to: form.get('to'),
      remove: form.get('remove') === 'true',
    });
  if (!parsed.success) return { ok: false, error: 'Zwei Workflow-Schritte auswählen.' };
  return withStaff(
    async (tx, { session }) => {
      await changeDependencyTx(tx, session, parsed.data.from, parsed.data.to, parsed.data.remove);
    },
    { module: 'workflowDependencies', revalidate: '/staff/mandate-expansion/dependencies' },
  );
}
export async function prepareOffboardingAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = z
    .object({
      clientId: z.string().uuid(),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
      endDate: z.string(),
      versionIds: z.array(z.string().uuid()).max(200),
      sensitiveVersionIds: z.array(z.string().uuid()).max(200),
      recipient: z.string().trim().min(10).max(800),
      handoverNote: z.string().trim().min(10).max(6000),
      retentionNote: z.string().trim().min(10).max(6000),
      confirmed: z.literal(true),
    })
    .safeParse({
      clientId: form.get('clientId'),
      expectedHash: form.get('expectedHash'),
      endDate: form.get('endDate'),
      versionIds: form.getAll('versionIds'),
      sensitiveVersionIds: form.getAll('sensitiveVersionIds'),
      recipient: form.get('recipient'),
      handoverNote: form.get('handoverNote'),
      retentionNote: form.get('retentionNote'),
      confirmed: form.get('confirmed') === 'on',
    });
  if (!parsed.success)
    return {
      ok: false,
      error:
        'Datum, Übergabe- und Aufbewahrungsvermerk sowie ausdrückliche Prüfung sind erforderlich.',
    };
  return withStaff(
    async (tx, { session }) => {
      await prepareOffboardingTx(tx, session, parsed.data);
    },
    {
      module: 'mandateOffboarding',
      requireAdmin: true,
      revalidate: '/staff/mandate-expansion/offboarding',
    },
  );
}
export async function finishOffboardingAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const guard = await staffActionGuard({ module: 'mandateOffboarding', requireAdmin: true });
  if (!guard.ok) return guard;
  const parsed = z
    .object({
      id: z.string().uuid(),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
      confirmed: z.literal(true),
    })
    .safeParse({
      id: form.get('id'),
      expectedHash: form.get('expectedHash'),
      confirmed: form.get('confirmed') === 'on',
    });
  if (!parsed.success)
    return {
      ok: false,
      error: 'Aktuellen Freigabestand, Beendigung und Zugangssperre ausdrücklich bestätigen.',
    };
  try {
    const result = await withTenantContext(guard.ctx, (tx) =>
      finishOffboardingTx(tx, guard.session, parsed.data.id, parsed.data.expectedHash),
    );
    // Persistent mandate-state checks already block every portal request. Redis also invalidates old tokens after any later reopening.
    const revoked = await Promise.allSettled(
      result.contactIds.map((id) => revokeAllSessions('portal', id)),
    );
    revalidatePath('/staff/mandate-expansion/offboarding');
    revalidatePath(`/staff/clients/${result.clientId}`);
    if (revoked.some((r) => r.status === 'rejected'))
      return {
        ok: false,
        error:
          'Mandat wurde beendet und Portalzugriff ist gesperrt. Einzelne zusätzliche Token-Widerrufe konnten nicht bestätigt werden; vor Wiederaufnahme administrativ prüfen.',
      };
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
export async function recordVdbStateAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = z
    .object({
      poaId: z.string().uuid(),
      expectedRevision: z.coerce.number().int().min(0),
      status: z.enum(VDB_STATES),
      recordedAt: z.string(),
      externalReference: z.string().trim().max(300),
      evidenceVersionId: z.string().uuid().nullable(),
      note: z.string().trim().min(10).max(3000),
    })
    .safeParse({
      poaId: form.get('poaId'),
      expectedRevision: form.get('expectedRevision'),
      status: form.get('status'),
      recordedAt: form.get('recordedAt'),
      externalReference: form.get('externalReference') ?? '',
      evidenceVersionId: form.get('evidenceVersionId') || null,
      note: form.get('note'),
    });
  if (!parsed.success)
    return {
      ok: false,
      error: 'Status, Nachweisdatum und eine Erläuterung (mindestens 10 Zeichen) angeben.',
    };
  return withStaff(
    async (tx, { session }) => {
      await recordVdbStateTx(tx, session, parsed.data);
    },
    { module: 'vdbPreparation', revalidate: '/staff/mandate-expansion/vdb' },
  );
}
export async function archiveStructureAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const guard = await staffActionGuard({ module: 'mandateStructure' });
  if (!guard.ok) return guard;
  try {
    await archiveStructure({
      clientId: String(form.get('clientId')),
      versionId: String(form.get('versionId')),
    });
    revalidatePath('/staff/mandate-expansion/structure');
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
export async function archiveOffboardingAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const guard = await staffActionGuard({ module: 'mandateOffboarding', requireAdmin: true });
  if (!guard.ok) return guard;
  try {
    await archiveOffboarding({
      id: String(form.get('id')),
      expectedHash: String(form.get('expectedHash')),
    });
    revalidatePath('/staff/mandate-expansion/offboarding');
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
