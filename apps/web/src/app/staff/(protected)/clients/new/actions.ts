'use server';

import { areProfessionalAssigneesEligibleTx } from '@/server/gwg/professional-review';

import { redirect } from 'next/navigation';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { z } from 'zod';
import { staffAction, ActionError, type ActionResult } from '@/server/actions/staff-action';
import { validationFailure } from '@/server/actions/form-data';

const createClientSchema = z
  .object({
    name: z.string().min(1, 'Name ist Pflichtfeld'),
    kind: z.enum(['NATPERS', 'JURPERS', 'PERSGES']),
    datevNo: z.string().optional(),
    street: z.string().max(200).optional().or(z.literal('')),
    postalCode: z.string().max(20).optional().or(z.literal('')),
    city: z.string().max(100).optional().or(z.literal('')),
    countryIso: z.string().length(2).optional().or(z.literal('')),
    invoiceEmail: z.string().email().max(255).optional().or(z.literal('')),
    berufstraegerIds: z.array(z.string().uuid()).min(1, 'Mindestens ein Berufsträger ist Pflicht.'),
    hauptbearbeiterIds: z.array(z.string().uuid()),
  })
  // P2-22: Formatprüfungen für deutsche Mandanten.
  .superRefine((d, ctx) => {
    const iso = (d.countryIso || 'DE').toUpperCase();
    if (iso === 'DE') {
      if (d.postalCode && !/^\d{5}$/.test(d.postalCode)) {
        ctx.addIssue({
          code: 'custom',
          path: ['postalCode'],
          message: 'PLZ (DE): genau 5 Ziffern.',
        });
      }
    }
  });

export async function createClientAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // ACCESS-STAFF-PERMISSION-001: Mandanten anlegen verlangt das Einzelrecht
  // CLIENT_CREATE; ADMIN/PARTNER besitzen es implizit, andere Mitarbeitende per
  // Grant (Benutzerverwaltung). Dieselbe Prüfung (hasStaffPermission) steuert
  // Seite, Buttons und Leerzustände. Neue Mandanten starten mit
  // allowActive=false; die GwG-Schranke bleibt also geschlossen.
  const result = await staffAction({
    guard: { requirePermission: 'CLIENT_CREATE' },
    run: async ({ tenantId, staffId, ctx }) => {
      const confirmDuplicate = formData.get('confirmDuplicate') === '1';
      const parsed = createClientSchema.safeParse({
        name: formData.get('name'),
        kind: formData.get('kind'),
        datevNo: formData.get('datevNo') || undefined,
        street: formData.get('street') ?? '',
        postalCode: formData.get('postalCode') ?? '',
        city: formData.get('city') ?? '',
        countryIso: ((formData.get('countryIso') as string) ?? '').toUpperCase(),
        invoiceEmail: formData.get('invoiceEmail') ?? '',
        berufstraegerIds: formData.getAll('berufstraegerIds').map(String),
        hauptbearbeiterIds: formData.getAll('hauptbearbeiterIds').map(String),
      });

      if (!parsed.success) {
        return validationFailure(
          parsed.error.issues,
          parsed.error.issues.map((i) => i.message).join(', '),
        );
      }

      const {
        name,
        kind,
        datevNo,
        street,
        postalCode,
        city,
        countryIso,
        invoiceEmail,
        berufstraegerIds,
        hauptbearbeiterIds,
      } = parsed.data;
      const uniqueBerufstraegerIds = Array.from(new Set(berufstraegerIds));
      const uniqueHauptbearbeiterIds = Array.from(new Set(hauptbearbeiterIds));

      const clientId = await withTenantContext(ctx, async (tx) => {
        const assignedStaffIds = Array.from(
          new Set([...uniqueBerufstraegerIds, ...uniqueHauptbearbeiterIds]),
        );
        const activeStaffCount = await tx.staffUser.count({
          where: {
            tenantId,
            id: { in: assignedStaffIds },
            active: true,
            roles: { some: {} },
          },
        });
        if (activeStaffCount !== assignedStaffIds.length) {
          throw new ActionError(
            'Eine gewählte Zuständigkeit ist nicht mehr aktiv oder hat keine gültige Staff-Rolle.',
          );
        }
        if (!(await areProfessionalAssigneesEligibleTx(tx, tenantId, uniqueBerufstraegerIds))) {
          throw new ActionError(
            'Als Berufsträger sind nur aktive, als Berufsträger qualifizierte Mitarbeiter zulässig.',
          );
        }

        // P2-22: Soft-Duplikat-Warnung (überspringbar via confirmDuplicate). Trifft
        // bei gleichem Namen (normalisiert) + gleicher PLZ oder gleicher
        // Rechnungs-E-Mail. Verhindert versehentliche Doppelanlage.
        if (!confirmDuplicate) {
          const dupe = await tx.client.findFirst({
            where: {
              tenantId,
              OR: [
                ...(postalCode
                  ? [{ name: { equals: name, mode: 'insensitive' as const }, postalCode }]
                  : []),
                ...(invoiceEmail
                  ? [{ invoiceEmail: { equals: invoiceEmail, mode: 'insensitive' as const } }]
                  : []),
              ],
            },
            select: { name: true },
          });
          if (dupe) {
            throw new ActionError(
              `Möglicher Doppel-Mandant („${dupe.name}"). Bitte prüfen — zum Anlegen erneut mit „Trotzdem anlegen" bestätigen.`,
            );
          }
        }

        const client = await tx.client.create({
          data: {
            tenantId,
            name,
            kind,
            datevNo: datevNo ?? null,
            allowActive: false,
            street: street || null,
            postalCode: postalCode || null,
            city: city || null,
            countryIso: countryIso || null,
            invoiceEmail: invoiceEmail || null,
          },
        });

        for (const sid of uniqueBerufstraegerIds) {
          await tx.clientResponsibility.create({
            data: { tenantId, clientId: client.id, staffId: sid, role: 'BERUFSTRAEGER' },
          });
        }
        for (const sid of uniqueHauptbearbeiterIds) {
          await tx.clientResponsibility.create({
            data: { tenantId, clientId: client.id, staffId: sid, role: 'HAUPTBEARBEITER' },
          });
        }

        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'client.created',
          resourceType: 'client',
          resourceId: client.id,
          after: {
            name,
            kind,
            datevNo: datevNo ?? null,
            hasAddress: !!(street && city),
            berufstraegerIds: uniqueBerufstraegerIds,
            hauptbearbeiterIds: uniqueHauptbearbeiterIds,
          },
        });

        return client.id;
      });
      return { clientId };
    },
    // P2-22: Unique-Konflikt (DATEV-Nr. je Tenant) freundlich melden statt
    // unbehandeltem Serverfehler.
    onError: (e) =>
      !(e instanceof ActionError) && (e as { code?: string }).code === 'P2002'
        ? { ok: false, error: 'DATEV-Nr. ist in dieser Kanzlei bereits vergeben.' }
        : undefined,
  });
  if (!result.ok) return result;
  redirect(`/staff/clients/${result.clientId}`);
}
