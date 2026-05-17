'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

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
});

function emptyToNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export async function saveAdminFieldsAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) throw new Error('Nicht eingeloggt.');
  const parsed = AdminSchema.safeParse({
    clientId: formData.get('clientId'),
    datevNo: formData.get('datevNo'),
    addisonNo: formData.get('addisonNo'),
    invoiceEmail: formData.get('invoiceEmail'),
    priority: formData.get('priority'),
    internalNotes: formData.get('internalNotes'),
  });
  if (!parsed.success) throw new Error('Validierungsfehler.');
  const { tenantId, staffId } = session.user;
  const { clientId } = parsed.data;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.client.findUnique({
        where: { id: clientId },
        select: { datevNo: true, addisonNo: true, invoiceEmail: true, priority: true, internalNotes: true },
      });
      if (!before) throw new Error('Mandant nicht gefunden.');

      const prio = parsed.data.priority;
      const after = {
        datevNo: emptyToNull(parsed.data.datevNo),
        addisonNo: emptyToNull(parsed.data.addisonNo),
        invoiceEmail: emptyToNull(parsed.data.invoiceEmail),
        priority: prio === 'A' || prio === 'B' || prio === 'C' ? prio : null,
        internalNotes: emptyToNull(parsed.data.internalNotes),
      };

      await tx.client.update({ where: { id: clientId }, data: after });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client.update.administrative',
        resourceType: 'client',
        resourceId: clientId,
        before,
        after,
      });
    },
  );

  revalidatePath(`/staff/clients/${clientId}`);
  revalidatePath(`/staff/clients/${clientId}/edit`);
}

// ----------------------------------------------------------------------------
// Sektion 2: GwG-relevante Daten — Trigger Re-Verifikation
// ----------------------------------------------------------------------------

const GWG_KINDS = ['NATPERS', 'JURPERS', 'PERSGES'] as const;

const GwgSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(255),
  kind: z.enum(GWG_KINDS),
  vatId: z.string().max(20).optional().nullable(),
  street: z.string().max(255).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  countryIso: z.string().length(2).optional().nullable().or(z.literal('')),
});

export async function saveGwgFieldsAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) throw new Error('Nicht eingeloggt.');
  const parsed = GwgSchema.safeParse({
    clientId: formData.get('clientId'),
    name: formData.get('name'),
    kind: formData.get('kind'),
    vatId: formData.get('vatId'),
    street: formData.get('street'),
    postalCode: formData.get('postalCode'),
    city: formData.get('city'),
    countryIso: formData.get('countryIso'),
  });
  if (!parsed.success) throw new Error('Validierungsfehler.');
  const { tenantId, staffId } = session.user;
  const { clientId } = parsed.data;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.client.findUnique({
        where: { id: clientId },
        select: {
          name: true, kind: true, vatId: true,
          street: true, postalCode: true, city: true, countryIso: true,
        },
      });
      if (!before) throw new Error('Mandant nicht gefunden.');

      const after = {
        name: parsed.data.name.trim(),
        kind: parsed.data.kind,
        vatId: emptyToNull(parsed.data.vatId),
        street: emptyToNull(parsed.data.street),
        postalCode: emptyToNull(parsed.data.postalCode),
        city: emptyToNull(parsed.data.city),
        countryIso: emptyToNull(parsed.data.countryIso),
      };

      // Diff: Was hat sich tatsächlich geändert? Wenn nichts → kein Re-Trigger.
      const changed: string[] = [];
      for (const k of ['name', 'kind', 'vatId', 'street', 'postalCode', 'city', 'countryIso'] as const) {
        if (before[k] !== after[k]) changed.push(k);
      }

      await tx.client.update({ where: { id: clientId }, data: after });

      let gwgReset = false;
      if (changed.length > 0) {
        // Bestehenden VERIFIED-Check auf IN_REVIEW zurücksetzen
        const verifiedCount = await tx.gwgCheck.updateMany({
          where: { clientId, status: 'VERIFIED' },
          data: { status: 'IN_REVIEW' },
        });
        gwgReset = verifiedCount.count > 0;
      }

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client.update.gwg_relevant',
        resourceType: 'client',
        resourceId: clientId,
        before,
        after: { ...after, _changedFields: changed, _gwgReverificationTriggered: gwgReset },
      });
    },
  );

  revalidatePath(`/staff/clients/${clientId}`);
  revalidatePath(`/staff/clients/${clientId}/edit`);
  revalidatePath(`/staff/clients/${clientId}/gwg`);
}

// ----------------------------------------------------------------------------
// Bearbeiter-Zuordnung
// ----------------------------------------------------------------------------

const RespSchema = z.object({
  clientId: z.string().uuid(),
  berufstraegerId: z.string().uuid().optional().or(z.literal('')),
  hauptbearbeiterIds: z.array(z.string().uuid()),
});

export async function setResponsibilitiesAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) throw new Error('Nicht eingeloggt.');
  // Berufsträger-Zuordnung bestimmt GwG-Verantwortung — nur ADMIN/PARTNER.
  if (!isStaffAdmin(session)) {
    throw new Error('Nur ADMIN/PARTNER darf Bearbeiter-Zuordnungen ändern.');
  }
  const ids = formData.getAll('hauptbearbeiterIds').map((v) => String(v));
  const parsed = RespSchema.safeParse({
    clientId: formData.get('clientId'),
    berufstraegerId: formData.get('berufstraegerId') ?? '',
    hauptbearbeiterIds: ids,
  });
  if (!parsed.success) throw new Error('Validierungsfehler.');
  const { tenantId, staffId: actorId } = session.user;
  const { clientId, berufstraegerId, hauptbearbeiterIds } = parsed.data;

  await withTenantContext(
    { tenantId, actorId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.clientResponsibility.findMany({ where: { clientId } });

      // 1. Berufsträger neu setzen — nur 1 erlaubt
      const oldBerufstraeger = before.find((b) => b.role === 'BERUFSTRAEGER');
      if (oldBerufstraeger && oldBerufstraeger.staffId !== berufstraegerId) {
        await tx.clientResponsibility.delete({ where: { id: oldBerufstraeger.id } });
      }
      if (berufstraegerId && (!oldBerufstraeger || oldBerufstraeger.staffId !== berufstraegerId)) {
        await tx.clientResponsibility.create({
          data: { tenantId, clientId, staffId: berufstraegerId, role: 'BERUFSTRAEGER' },
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
        (oldBerufstraeger?.staffId ?? '') !== (berufstraegerId ?? '') ||
        toAdd.length > 0 || toRemove.length > 0;
      if (changed) {
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId,
          action: 'client.responsibilities.update',
          resourceType: 'client',
          resourceId: clientId,
          before: {
            berufstraegerId: oldBerufstraeger?.staffId ?? null,
            hauptbearbeiterIds: oldHaupt,
          },
          after: {
            berufstraegerId: berufstraegerId || null,
            hauptbearbeiterIds,
          },
        });
      }
    },
  );

  revalidatePath(`/staff/clients/${clientId}`);
  revalidatePath(`/staff/clients/${clientId}/edit`);
}
