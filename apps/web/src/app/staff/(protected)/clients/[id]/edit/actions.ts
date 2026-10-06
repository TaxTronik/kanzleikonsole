'use server';

import { areProfessionalAssigneesEligibleTx } from '@/server/gwg/professional-review';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { isStaffAdmin, assertClientAccessTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { staffAction, ActionError } from '@/server/actions/staff-action';
import { formFlag, formList, parseFormData } from '@/server/actions/form-data';
import { lockGwgCheckLifecycleTx, requireGwgReverificationTx } from '@/server/gwg/reverification';
import { audit } from '@/server/actions/audit';

export interface ActionResult {
  ok: boolean;
  error?: string;
  savedAt?: string;
}

// ----------------------------------------------------------------------------
// Sektion 1: Verwaltungsdaten — frei änderbar, kein GwG-Trigger
// ----------------------------------------------------------------------------

const AdminSchema = z.object({
  clientId: z.string().uuid(),
  datevNo: z.string().max(50).optional().nullable(),
  addisonNo: z.string().max(50).optional().nullable(),
  invoiceEmail: z.string().email().max(255).optional().nullable().or(z.literal('')),
  priority: z.enum(['A', 'B', 'C']).nullable().optional().or(z.literal('')),
  internalNotes: z.string().max(10_000).optional().nullable(),
  // Zugriffs-Ventil (vertraulicher Mandant). Wird nur von Admin/Partner übernommen.
  vertraulich: formFlag('on', z.boolean().optional()),
});

function emptyToNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export async function saveAdminFieldsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    run: async ({ ctx, session }) => {
      const parsed = parseFormData(AdminSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler — bitte Eingaben prüfen.',
      });
      if (!parsed.ok) return parsed;
      const { clientId } = parsed.data;
      // Die Vertraulich-Markierung ist eine Zugriffssteuerung → nur Admin/Partner.
      const isAdmin = isStaffAdmin(session);

      await withTenantContext(ctx, async (tx) => {
        await assertClientAccessTx(tx, session, clientId);
        const before = await tx.client.findUnique({
          where: { id: clientId },
          select: {
            datevNo: true,
            addisonNo: true,
            invoiceEmail: true,
            priority: true,
            internalNotes: true,
            vertraulich: true,
          },
        });
        if (!before) throw new ActionError('Mandant nicht gefunden.');

        const prio = parsed.data.priority;
        const after = {
          datevNo: emptyToNull(parsed.data.datevNo),
          addisonNo: emptyToNull(parsed.data.addisonNo),
          invoiceEmail: emptyToNull(parsed.data.invoiceEmail),
          priority: prio === 'A' || prio === 'B' || prio === 'C' ? prio : null,
          internalNotes: emptyToNull(parsed.data.internalNotes),
          // Nicht-Admins können das Flag nicht ändern → Bestand behalten (die
          // Checkbox ist für sie ohnehin deaktiviert und sendet nichts).
          vertraulich: isAdmin ? (parsed.data.vertraulich ?? false) : before.vertraulich,
        };

        await tx.client.update({ where: { id: clientId }, data: after });
        await audit(tx, ctx, {
          action: 'client.update.administrative',
          resourceType: 'client',
          resourceId: clientId,
          before,
          after: {
            ...after,
            // Steuerliche/organisatorische Verwaltungswerte sind ausdrücklich
            // kein Anlass für eine erneute Identifizierung nach GwG.
            _gwgReverificationTriggered: false,
          },
        });
      });

      revalidatePath(`/staff/clients/${clientId}`);
      revalidatePath(`/staff/clients/${clientId}/edit`);
      return { savedAt: new Date().toISOString() };
    },
  });
}

// ----------------------------------------------------------------------------
// Sektion 2: GwG-relevante Daten — Trigger Re-Verifikation
// ----------------------------------------------------------------------------

const GWG_KINDS = ['NATPERS', 'JURPERS', 'PERSGES'] as const;

const GwgSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(255),
  kind: z.enum(GWG_KINDS),
  street: z.string().max(255).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  countryIso: z.string().length(2).optional().nullable().or(z.literal('')),
});

export async function saveGwgFieldsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    run: async ({ tenantId, ctx, session }) => {
      const parsed = parseFormData(GwgSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler — bitte Eingaben prüfen.',
      });
      if (!parsed.ok) return parsed;
      const { clientId } = parsed.data;

      await withTenantContext(ctx, async (tx) => {
        await assertClientAccessTx(tx, session, clientId);
        await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
        const before = await tx.client.findUnique({
          where: { id: clientId },
          select: {
            name: true,
            kind: true,
            street: true,
            postalCode: true,
            city: true,
            countryIso: true,
          },
        });
        if (!before) throw new ActionError('Mandant nicht gefunden.');

        const after = {
          name: parsed.data.name.trim(),
          kind: parsed.data.kind,
          street: emptyToNull(parsed.data.street),
          postalCode: emptyToNull(parsed.data.postalCode),
          city: emptyToNull(parsed.data.city),
          countryIso: emptyToNull(parsed.data.countryIso),
        };

        // Diff: Was hat sich tatsächlich geändert? Wenn nichts → kein Re-Trigger.
        const changed: string[] = [];
        for (const k of ['name', 'kind', 'street', 'postalCode', 'city', 'countryIso'] as const) {
          if (before[k] !== after[k]) changed.push(k);
        }

        await tx.client.update({ where: { id: clientId }, data: after });

        let gwgReset = false;
        let gwgReviewCheckId: string | null = null;
        let gwgInvalidatedIdentityDocuments = 0;
        if (changed.length > 0) {
          // Bestehenden VERIFIED-Check auf IN_REVIEW zurücksetzen
          const reset = await requireGwgReverificationTx(tx, { tenantId, clientId });
          gwgReset = reset.reviewCheckId !== null;
          gwgReviewCheckId = reset.reviewCheckId;
          gwgInvalidatedIdentityDocuments = reset.invalidatedIdentityDocuments;
        }

        await audit(tx, ctx, {
          action: 'client.update.gwg_relevant',
          resourceType: 'client',
          resourceId: clientId,
          before,
          after: {
            ...after,
            _changedFields: changed,
            _gwgReverificationTriggered: gwgReset,
            _gwgReviewCheckId: gwgReviewCheckId,
            _gwgInvalidatedIdentityDocuments: gwgInvalidatedIdentityDocuments,
          },
        });
      });

      revalidatePath(`/staff/clients/${clientId}`);
      revalidatePath(`/staff/clients/${clientId}/edit`);
      revalidatePath(`/staff/clients/${clientId}/gwg`);
      return { savedAt: new Date().toISOString() };
    },
  });
}

// ----------------------------------------------------------------------------
// Bearbeiter-Zuordnung
// ----------------------------------------------------------------------------

const RespSchema = z.object({
  clientId: z.string().uuid(),
  berufstraegerIds: formList(z.array(z.string().uuid())),
  hauptbearbeiterIds: formList(z.array(z.string().uuid())),
});

export async function setResponsibilitiesAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    // Berufsträger-Zuordnung bestimmt GwG-Verantwortung — nur ADMIN/PARTNER
    // (eigene, präzisere Meldung als der Standard-Gate).
    guard: {
      requireAdmin: true,
      deniedMessage: 'Nur ADMIN/PARTNER darf Bearbeiter-Zuordnungen ändern.',
    },
    run: async ({ tenantId, ctx, session }) => {
      const parsed = parseFormData(RespSchema, formData, {
        repeatable: ['berufstraegerIds', 'hauptbearbeiterIds'],
        absentAsNull: true,
        errorMessage: 'Validierungsfehler — bitte Eingaben prüfen.',
      });
      if (!parsed.ok) return parsed;
      const { clientId } = parsed.data;
      // Mehrfachwerte aus manipulierten/dupliziert abgesendeten Formularfeldern
      // dürfen nicht zu doppelten CREATEs und einem künstlichen Unique-Konflikt führen.
      const berufIds = Array.from(new Set(parsed.data.berufstraegerIds));
      const hauptbearbeiterIds = Array.from(new Set(parsed.data.hauptbearbeiterIds));

      // Praxis-Check: mind. ein Berufsträger erforderlich (sonst kein GwG-Verifier
      // mehr). Wenn alle Berufsträger entfernt werden sollen → explizit ablehnen,
      // damit kein Mandant in einen broken state läuft.
      if (berufIds.length === 0) {
        return { ok: false, error: 'Mindestens ein Berufsträger muss zugeordnet sein.' };
      }

      await withTenantContext(ctx, async (tx) => {
        await assertClientAccessTx(tx, session, clientId);
        const assignedStaffIds = Array.from(new Set([...berufIds, ...hauptbearbeiterIds]));
        const eligibleStaffCount = await tx.staffUser.count({
          where: {
            tenantId,
            id: { in: assignedStaffIds },
            active: true,
            roles: { some: {} },
          },
        });
        if (eligibleStaffCount !== assignedStaffIds.length) {
          throw new ActionError(
            'Eine gewählte Zuständigkeit ist nicht mehr aktiv oder hat keine gültige Staff-Rolle.',
          );
        }
        if (!(await areProfessionalAssigneesEligibleTx(tx, tenantId, berufIds))) {
          throw new ActionError(
            'Als Berufsträger sind nur aktive, als Berufsträger qualifizierte Mitarbeiter zulässig.',
          );
        }
        const before = await tx.clientResponsibility.findMany({ where: { clientId } });

        // 1. Berufsträger — Diff. Mehrere möglich (Gesellschafter-Konstellationen,
        //    fachlich geteilte Mandate). Schema-unique ist (clientId, staffId, role),
        //    also pro Staff genau 1 Eintrag — beliebig viele Staffs.
        const oldBeruf = before.filter((b) => b.role === 'BERUFSTRAEGER').map((b) => b.staffId);
        const oldBerufSet = new Set(oldBeruf);
        const newBerufSet = new Set(berufIds);
        const berufToRemove = oldBeruf.filter((id) => !newBerufSet.has(id));
        const berufToAdd = berufIds.filter((id) => !oldBerufSet.has(id));

        if (berufToRemove.length > 0) {
          await tx.clientResponsibility.deleteMany({
            where: { clientId, role: 'BERUFSTRAEGER', staffId: { in: berufToRemove } },
          });
        }
        for (const sid of berufToAdd) {
          await tx.clientResponsibility.create({
            data: { tenantId, clientId, staffId: sid, role: 'BERUFSTRAEGER' },
          });
        }

        // 2. Hauptbearbeiter — Diff
        const oldHaupt = before.filter((b) => b.role === 'HAUPTBEARBEITER').map((b) => b.staffId);
        const oldHauptSet = new Set(oldHaupt);
        const newHauptSet = new Set(hauptbearbeiterIds);
        const toRemove = oldHaupt.filter((id) => !newHauptSet.has(id));
        const toAdd = hauptbearbeiterIds.filter((id) => !oldHauptSet.has(id));

        if (toRemove.length > 0) {
          await tx.clientResponsibility.deleteMany({
            where: { clientId, role: 'HAUPTBEARBEITER', staffId: { in: toRemove } },
          });
        }
        for (const sid of toAdd) {
          await tx.clientResponsibility.create({
            data: { tenantId, clientId, staffId: sid, role: 'HAUPTBEARBEITER' },
          });
        }

        const changed =
          berufToAdd.length > 0 ||
          berufToRemove.length > 0 ||
          toAdd.length > 0 ||
          toRemove.length > 0;
        if (changed) {
          await audit(tx, ctx, {
            action: 'client.responsibilities.update',
            resourceType: 'client',
            resourceId: clientId,
            before: { berufstraegerIds: oldBeruf, hauptbearbeiterIds: oldHaupt },
            after: { berufstraegerIds: berufIds, hauptbearbeiterIds },
          });
        }
      });

      revalidatePath(`/staff/clients/${clientId}`);
      revalidatePath(`/staff/clients/${clientId}/edit`);
      return { savedAt: new Date().toISOString() };
    },
  });
}

// ----------------------------------------------------------------------------
// Mandatsende (GwG § 8 Abs. 4): startet/stoppt die Lösch-Uhr für GwG-Belege.
// Berufsrechtlich/compliance-relevant → ADMIN/PARTNER, eigene Meldung.
// ----------------------------------------------------------------------------

const MandateEndSchema = z.object({
  clientId: z.string().uuid(),
  ended: formFlag(['on', '1']),
});

export async function setMandateEndAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true, deniedMessage: 'Nur ADMIN/PARTNER darf das Mandatsende setzen.' },
    run: async ({ ctx, session }) => {
      const parsed = parseFormData(MandateEndSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;
      const { clientId, ended } = parsed.data;

      await withTenantContext(ctx, async (tx) => {
        await assertClientAccessTx(tx, session, clientId);
        const before = await tx.client.findUnique({
          where: { id: clientId },
          select: { mandateEndedAt: true },
        });
        if (!before) throw new ActionError('Mandant nicht gefunden.');
        // Setzen = jetzt (Mandatsende-Datum); Zurücknehmen = null. Ein bereits
        // gesetztes Datum NICHT überschreiben (die Frist soll am ursprünglichen
        // Ende hängen), wenn erneut „beendet" geklickt wird.
        const next = ended ? (before.mandateEndedAt ?? new Date()) : null;
        await tx.client.update({ where: { id: clientId }, data: { mandateEndedAt: next } });
        await audit(tx, ctx, {
          action: ended ? 'client.mandate.end' : 'client.mandate.reopen',
          resourceType: 'client',
          resourceId: clientId,
          before: { mandateEndedAt: before.mandateEndedAt?.toISOString() ?? null },
          after: { mandateEndedAt: next?.toISOString() ?? null },
        });
      });

      revalidatePath(`/staff/clients/${clientId}`);
      revalidatePath(`/staff/clients/${clientId}/edit`);
      revalidatePath('/staff/admin/gwg-retention');
      return { savedAt: new Date().toISOString() };
    },
  });
}
