'use server';
import { z } from 'zod';
import { withStaff, staffAction, type ActionResult } from '@/server/actions/staff-action';
import { formDefault, formEmpty, formFlag, parseFormData } from '@/server/actions/form-data';
import { withTenantContext } from '@taxtronik/db';
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
  const parsed = parseFormData(
    z.object({
      instanceId: z.string().uuid(),
      year: z.coerce.number().int().min(1900).max(2200),
      expectedYear: formEmpty(null, z.coerce.number().int().nullable()),
    }),
    form,
    { absentAsNull: true, errorMessage: 'Workflow und Veranlagungsjahr angeben.' },
  );
  if (!parsed.ok) return parsed;
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
  const parsed = parseFormData(
    z.object({ from: z.string().uuid(), to: z.string().uuid(), remove: formFlag('true') }),
    form,
    { absentAsNull: true, errorMessage: 'Zwei Workflow-Schritte auswählen.' },
  );
  if (!parsed.ok) return parsed;
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
  const parsed = parseFormData(
    z.object({
      clientId: z.string().uuid(),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
      endDate: z.string(),
      versionIds: z.array(z.string().uuid()).max(200),
      sensitiveVersionIds: z.array(z.string().uuid()).max(200),
      recipient: z.string().trim().min(10).max(800),
      handoverNote: z.string().trim().min(10).max(6000),
      retentionNote: z.string().trim().min(10).max(6000),
      confirmed: formFlag('on', z.literal(true)),
    }),
    form,
    {
      repeatable: ['versionIds', 'sensitiveVersionIds'],
      absentAsNull: true,
      errorMessage:
        'Datum, Übergabe- und Aufbewahrungsvermerk sowie ausdrückliche Prüfung sind erforderlich.',
    },
  );
  if (!parsed.ok) return parsed;
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
  return staffAction({
    guard: { module: 'mandateOffboarding', requireAdmin: true },
    parse: () =>
      parseFormData(
        z.object({
          id: z.string().uuid(),
          expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
          confirmed: formFlag('on', z.literal(true)),
        }),
        form,
        {
          absentAsNull: true,
          errorMessage:
            'Aktuellen Freigabestand, Beendigung und Zugangssperre ausdrücklich bestätigen.',
        },
      ),
    run: async (guard, data) => {
      const result = await withTenantContext(guard.ctx, (tx) =>
        finishOffboardingTx(tx, guard.session, data.id, data.expectedHash),
      );
      // Persistent mandate-state checks already block every portal request. Redis also invalidates old tokens after any later reopening.
      const revoked = await Promise.allSettled(
        result.contactIds.map((id) => revokeAllSessions('portal', id)),
      );
      // Auch bei einem unbestätigten Token-Widerruf ist das Mandat beendet: die
      // Pfade werden vor der Teilerfolgs-Meldung revalidiert.
      revalidatePath('/staff/mandate-expansion/offboarding');
      revalidatePath(`/staff/clients/${result.clientId}`);
      if (revoked.some((r) => r.status === 'rejected'))
        return {
          ok: false,
          error:
            'Mandat wurde beendet und Portalzugriff ist gesperrt. Einzelne zusätzliche Token-Widerrufe konnten nicht bestätigt werden; vor Wiederaufnahme administrativ prüfen.',
        };
    },
  });
}
export async function recordVdbStateAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = parseFormData(
    z.object({
      poaId: z.string().uuid(),
      expectedRevision: z.coerce.number().int().min(0),
      status: z.enum(VDB_STATES),
      recordedAt: z.string(),
      externalReference: formDefault('', z.string().trim().max(300)),
      evidenceVersionId: formEmpty(null, z.string().uuid().nullable()),
      note: z.string().trim().min(10).max(3000),
    }),
    form,
    {
      absentAsNull: true,
      errorMessage: 'Status, Nachweisdatum und eine Erläuterung (mindestens 10 Zeichen) angeben.',
    },
  );
  if (!parsed.ok) return parsed;
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
  return staffAction({
    guard: { module: 'mandateStructure' },
    run: async () => {
      await archiveStructure({
        clientId: String(form.get('clientId')),
        versionId: String(form.get('versionId')),
      });
    },
    revalidate: '/staff/mandate-expansion/structure',
  });
}
export async function archiveOffboardingAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { module: 'mandateOffboarding', requireAdmin: true },
    run: async () => {
      await archiveOffboarding({
        id: String(form.get('id')),
        expectedHash: String(form.get('expectedHash')),
      });
    },
    revalidate: '/staff/mandate-expansion/offboarding',
  });
}
