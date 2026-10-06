'use server';

// GwG-Personen und wirtschaftlich Berechtigte: Parsen → Service in der
// Tenant-Transaktion → Ergebnis. Die Fachlogik liegt in server/gwg/persons.ts
// und server/gwg/beneficial-owners.ts (Review-Befund K-03).

import { z } from 'zod';
import { validateIdentityDates } from '@/server/gwg/identity-date-validation';
import {
  addGwgPersonTx,
  updateGwgPersonGeneralTx,
  type GwgPersonGeneralMutationPayload,
} from '@/server/gwg/persons';
import {
  addBeneficialOwnerRoleTx,
  removeBeneficialOwnerTx,
  updateBeneficialOwnerTx,
} from '@/server/gwg/beneficial-owners';
import { withStaff, parseFormData } from '@/server/actions/staff-action';

import {
  type ActionResult,
  type InvalidatedIdentitySet,
  type SavedBeneficialOwner,
} from './_action-helpers';

// Stabile Typ-Importpfade fuer die Form-Komponenten dieser Route.
export type { ActionResult, InvalidatedIdentitySet, SavedBeneficialOwner } from './_action-helpers';
export type { SavedGwgPersonGeneral } from '@/server/gwg/persons';

const CheckboxSchema = z
  .literal('on')
  .optional()
  .transform((value) => value === 'on');
const OptionalPercentageSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.coerce.number().min(0).max(100).optional(),
);

const AddGwgPersonSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    fullName: z.string().trim().min(1).max(200),
    isBeneficialOwner: CheckboxSchema,
    isRepresentative: CheckboxSchema,
    birthDate: z.string().date(),
    birthPlace: z.string().trim().min(1).max(200),
    residence: z.string().trim().min(1).max(500),
    nationality: z.string().trim().min(1).max(100),
    ownershipPct: OptionalPercentageSchema,
    isPep: z.enum(['true', 'false']).transform((value) => value === 'true'),
  })
  .superRefine((person, ctx) => {
    if (!person.isBeneficialOwner && !person.isRepresentative) {
      ctx.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'Mindestens eine Rolle auswählen.',
      });
    }
    for (const issue of validateIdentityDates({ birthDate: person.birthDate })) {
      ctx.addIssue({ code: 'custom', path: ['birthDate'], message: issue.message });
    }
  });

/**
 * Erfasst eine relevante natürliche Person zuerst als eigenes UI-Element und
 * ordnet ihr anschließend die ausgewählten Rollen zu. Eine Vertreterrolle
 * wird nie mehr über die Rechtsträgermaske als freie Namenszeile angelegt.
 *
 * Kein revalidate der aktuellen Route: das erzwang einen kompletten
 * RSC-Re-Render der GwG-Seite IN der Action-Antwort und ließ die
 * Form-Transition bis zur nächsten Interaktion hängen (UI "switcht" erst nach
 * erneutem Klick). Der Client ruft stattdessen nach dem Erfolg
 * router.refresh() außerhalb der Transition auf.
 */
export async function addGwgPersonAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = parseFormData(AddGwgPersonSchema, formData, {
    errorMessage: 'Die allgemeinen Angaben und mindestens eine Rolle sind erforderlich.',
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return withStaff((tx, staff) => addGwgPersonTx(tx, data, staff));
}

const OptionalUuidSchema = z
  .union([z.string().uuid(), z.literal('')])
  .transform((value) => value || undefined);

const UpdateGwgPersonGeneralSchema = z
  .object({
    ownerId: OptionalUuidSchema,
    representativeId: OptionalUuidSchema,
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    fullName: z.string().trim().min(1).max(200),
    birthDate: z.string().date(),
    birthPlace: z.string().trim().min(1).max(200),
    residence: z.string().trim().min(1).max(500),
    nationality: z.string().trim().min(1).max(100),
    isPep: z.enum(['true', 'false']).transform((value) => value === 'true'),
    expectedRevision: z.string().min(1),
  })
  .superRefine((person, ctx) => {
    if (!person.ownerId && !person.representativeId) {
      ctx.addIssue({ code: 'custom', path: ['person'], message: 'Personenbezug fehlt.' });
    }
    for (const issue of validateIdentityDates({ birthDate: person.birthDate })) {
      ctx.addIssue({ code: 'custom', path: ['birthDate'], message: issue.message });
    }
  });

export type GwgPersonGeneralActionResult = ActionResult & GwgPersonGeneralMutationPayload;

/**
 * Speichert allgemeine Angaben einmal auf Personenebene. Bei einer Doppelrolle
 * werden die beiden bestehenden Rollensnapshots atomar synchronisiert; die
 * Rollenmaske selbst verarbeitet nur noch rollenspezifische Werte.
 */
export async function updateGwgPersonGeneralAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<GwgPersonGeneralActionResult> {
  const parsed = parseFormData(UpdateGwgPersonGeneralSchema, formData, {
    errorMessage: 'Die allgemeinen Angaben sind unvollständig oder ungültig.',
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  const result = await withStaff((tx, staff) => updateGwgPersonGeneralTx(tx, data, staff));

  if (result.conflict && result.latest && result.revision) {
    return {
      ok: false,
      conflict: true,
      latest: result.latest,
      revision: result.revision,
      error:
        'Die allgemeinen Angaben wurden zwischenzeitlich geändert. Der aktuelle Stand wurde automatisch nachgeladen; Ihre Eingabe bleibt erhalten.',
    };
  }
  return result;
}

const AddBeneficialOwnerRoleSchema = z.object({
  representativeId: z.string().uuid(),
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  ownershipPct: OptionalPercentageSchema,
});

/**
 * Ergänzt eine bereits erfasste gesetzliche Vertretung um die Rolle als
 * wirtschaftlich Berechtigter (server/gwg/beneficial-owners.ts).
 */
export async function addBeneficialOwnerRoleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { createdOwnerId?: string; reviewReset?: boolean }> {
  const parsed = parseFormData(AddBeneficialOwnerRoleSchema, formData, {
    errorMessage: 'Die Rolle konnte nicht zugeordnet werden.',
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return withStaff((tx, staff) => addBeneficialOwnerRoleTx(tx, data, staff));
}

const UpdateOwnerSchema = z
  .object({
    ownerId: z.string().uuid(),
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    fullName: z.string().trim().min(1).max(200),
    birthDate: z.string().date(),
    birthPlace: z.string().trim().min(1).max(200),
    residence: z.string().trim().min(1).max(500),
    nationality: z.string().trim().min(1).max(100),
    ownershipPct: z.coerce.number().min(0).max(100).optional(),
    isPep: z.enum(['true', 'false']).transform((value) => value === 'true'),
    expectedRevision: z.string().min(2).max(20_000),
  })
  .superRefine((owner, ctx) => {
    for (const issue of validateIdentityDates({ birthDate: owner.birthDate })) {
      ctx.addIssue({ code: 'custom', path: ['birthDate'], message: issue.message });
    }
  });

/**
 * Korrigiert die Angaben eines vorhandenen wirtschaftlich Berechtigten
 * (server/gwg/beneficial-owners.ts). Jede inhaltliche Korrektur nimmt eine
 * laufende Freigabe zurueck.
 */
export async function updateBeneficialOwnerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    reviewReset?: boolean;
    revision?: string;
    saved?: SavedBeneficialOwner;
    invalidatedIdentitySets?: InvalidatedIdentitySet[];
  }
> {
  const parsed = UpdateOwnerSchema.safeParse({
    ownerId: formData.get('ownerId'),
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    fullName: formData.get('fullName'),
    birthDate: formData.get('birthDate') ?? '',
    birthPlace: formData.get('birthPlace') ?? '',
    residence: formData.get('residence') ?? '',
    nationality: formData.get('nationality') ?? '',
    ownershipPct: formData.get('ownershipPct') || undefined,
    isPep: formData.get('isPep'),
    expectedRevision: formData.get('expectedRevision'),
  });
  if (!parsed.success) return { ok: false, error: 'Ungültige Angaben zur Person.' };
  const data = parsed.data;

  return withStaff((tx, staff) => updateBeneficialOwnerTx(tx, data, staff));
}

const RemoveOwnerSchema = z.object({
  ownerId: z.string().uuid(),
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  expectedRevision: z.string().min(2).max(20_000),
});

/**
 * Entfernt eine nicht mehr wirtschaftlich berechtigte Person nur aus dem
 * aktuellen, bearbeitbaren Snapshot (server/gwg/beneficial-owners.ts).
 */
export async function removeBeneficialOwnerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    removedOwnerId?: string;
    reviewReset?: boolean;
    invalidatedIdentitySets?: InvalidatedIdentitySet[];
  }
> {
  const parsed = parseFormData(RemoveOwnerSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Ungültige Angaben zur Person.' };
  const data = parsed.data;

  return withStaff((tx, staff) => removeBeneficialOwnerTx(tx, data, staff));
}
