'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { isStaffAdmin, toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import {
  staffActionGuard,
  withStaff,
  ActionError,
  parseFormData,
} from '@/server/actions/staff-action';
import { createPoaRecord, preparePoaCreate, readPoaPdfBytes } from '@/server/poa/create-poa';
import { sendPoaForSignature } from '@/server/poa/send-for-signature';
import { revokePoaTx } from '@/server/poa/revoke-poa';
import {
  POA_CREATE_RETURN_CONTEXTS,
  poaCreateSuccessHref,
  type PoaCreateReturnContext,
} from './new/return-context';

const CreateSchema = z
  .object({
    clientId: z.string().uuid(),
    signerContactId: z.string().uuid().optional().or(z.literal('')),
    signerEmail: z.string().email().max(255),
    signerName: z.string().min(1).max(200),
    subject: z.string().min(1).max(300),
    scope: z.string().max(20000).optional(),
    validFrom: z.string().date(),
    validUntil: z.string().date().optional().or(z.literal('')),
    pendingDocumentId: z.string().uuid().optional().or(z.literal('')),
    uploadIntentId: z.string().uuid().optional().or(z.literal('')),
    returnContext: z.enum(POA_CREATE_RETURN_CONTEXTS).optional().or(z.literal('')),
  })
  .superRefine((value, ctx) => {
    if (value.validUntil && value.validUntil < value.validFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['validUntil'],
        message: 'Das Gültig-bis-Datum darf nicht vor dem Gültig-ab-Datum liegen.',
      });
    }
  });

export interface ActionResult {
  ok: boolean;
  error?: string;
  pendingDocumentId?: string;
}

export interface PoaSignerContactsResult {
  ok: boolean;
  error?: string;
  contacts?: Array<{ id: string; fullName: string; email: string }>;
}

/**
 * Aktive Kontakte des gewählten Mandanten für die Unterzeichner-Vorbelegung.
 * Ersetzt das frühere Vorladen ALLER Mandanten samt aller Kontakte in die
 * Anlageseite. Schranken wie Seite und Anlage: ADMIN/PARTNER, Vollmachtenmodul,
 * Mandantenzugriff, kein beendetes oder anonymisiertes Mandat.
 */
export async function loadPoaSignerContactsAction(
  clientId: string,
): Promise<PoaSignerContactsResult> {
  const parsedClientId = z.string().uuid().safeParse(clientId);
  if (!parsedClientId.success) return { ok: false, error: 'Ungültiger Mandant.' };
  const g = await staffActionGuard({ requireAdmin: true, modeModule: 'poa' });
  if (!g.ok) return { ok: false, error: g.error };
  try {
    const contacts = await withTenantContext(g.ctx, async (tx) => {
      await assertClientAccessTx(tx, g.session, parsedClientId.data);
      const client = await tx.client.findFirst({
        where: { id: parsedClientId.data, anonymizedAt: null, mandateEndedAt: null },
        select: {
          contacts: {
            where: { active: true },
            orderBy: { fullName: 'asc' },
            select: { id: true, fullName: true, email: true },
          },
        },
      });
      if (!client) throw new ActionError('Mandant nicht verfügbar.');
      return client.contacts;
    });
    return { ok: true, contacts };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * Anlage abgeschlossen (neu oder bereits zum Upload-Intent vorhanden):
 * Listen revalidieren und zur Vollmacht bzw. zurück ins Onboarding.
 */
function poaCreated(
  data: { clientId: string; returnContext?: PoaCreateReturnContext | '' },
  poaId: string,
): never {
  revalidatePath('/staff/poa');
  if (data.returnContext === 'onboarding') {
    revalidatePath(`/staff/clients/onboarding/${data.clientId}`);
  }
  redirect(
    poaCreateSuccessHref({
      clientId: data.clientId,
      poaId,
      returnContext: data.returnContext || undefined,
    }),
  );
}

/** Scheitert die Anlage-Transaktion, bleibt ein bereits gespeichertes PDF fortsetzbar. */
function poaCreateFailure(e: unknown, pdfDocumentId: string | null): ActionResult {
  const suffix = pdfDocumentId
    ? ' Das PDF bleibt nachvollziehbar in der Mandantenakte gespeichert.'
    : '';
  if (e instanceof ActionError) {
    return {
      ok: false,
      error: `${e.message}${suffix}`,
      pendingDocumentId: pdfDocumentId ?? undefined,
    };
  }
  return {
    ok: false,
    error: `Anlegen fehlgeschlagen.${suffix}`,
    pendingDocumentId: pdfDocumentId ?? undefined,
  };
}

/**
 * Vollmacht anlegen (Service: server/poa/create-poa.ts): Vorbereitung inkl.
 * Extern-PDF, dann die Anlage-Transaktion; Erfolg leitet weiter.
 */
export async function createPoaAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ modeModule: 'poa' });
  if (!g.ok) return { ok: false, error: g.error };

  // R-4: Vollmachtserteilung ist berufsrechtlich eine Erklärung des
  // Steuerberaters (§§ 3 ff. StBerG) — der Berufsträger trägt die Haftung.
  // Ein Sachbearbeiter ohne Bestellung darf das technisch nicht auslösen
  // können. ADMIN/PARTNER (in der Praxis: Kanzleileitung + Partner =
  // Berufsträger) als Gate. Für 4-Augen-Workflow später separater Schritt.
  if (!isStaffAdmin(g.session)) {
    return {
      ok: false,
      error: 'Vollmachten dürfen nur von ADMIN/PARTNER (Berufsträger) angelegt werden.',
    };
  }

  const parsed = CreateSchema.safeParse({
    clientId: formData.get('clientId'),
    signerContactId: formData.get('signerContactId') ?? '',
    signerEmail: formData.get('signerEmail'),
    signerName: formData.get('signerName'),
    subject: formData.get('subject'),
    // Im Extern-Modus sendet das Form kein scope-Feld → formData.get liefert
    // null. Zod .optional() akzeptiert aber nur undefined, nicht null — daher
    // auf '' coalescen (s. #2 "expected string, received null").
    scope: formData.get('scope') ?? '',
    validFrom: formData.get('validFrom'),
    validUntil: formData.get('validUntil') ?? '',
    pendingDocumentId: formData.get('pendingDocumentId') ?? '',
    uploadIntentId: formData.get('uploadIntentId') ?? '',
    returnContext: formData.get('returnContext') ?? '',
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
  }
  const data = parsed.data;

  const preparation = await preparePoaCreate(g, data, () => readPoaPdfBytes(formData));
  if (!preparation.ok) return preparation;
  if (preparation.prepared === null) return poaCreated(data, preparation.existingPoaId);
  const { prepared } = preparation;

  let id: string;
  try {
    id = await createPoaRecord(g, data, prepared);
  } catch (e) {
    return poaCreateFailure(e, prepared.pdf?.documentId ?? null);
  }
  return poaCreated(data, id);
}

const SendSchema = z.object({
  poaId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime(),
});

/** Vollmacht zur Unterschrift versenden (Service: server/poa/send-for-signature.ts). */
export async function sendForSignatureAction(formData: FormData): Promise<ActionResult> {
  const g = await staffActionGuard({ modeModule: 'poa' });
  if (!g.ok) return g;

  if (!isStaffAdmin(g.session)) {
    return {
      ok: false,
      error: 'Vollmachten dürfen nur von ADMIN/PARTNER zur Unterschrift versendet werden.',
    };
  }

  const parsed = parseFormData(SendSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Ungültig.' };

  const { poaId } = parsed.data;
  const result = await sendPoaForSignature(g, {
    poaId,
    expectedUpdatedAt: new Date(parsed.data.expectedUpdatedAt),
  });
  if (!result.ok) return result;

  revalidatePath('/staff/poa');
  revalidatePath(`/staff/poa/${poaId}`);
  return { ok: true };
}

const RevokeSchema = z.object({
  poaId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
});

export async function revokePoaAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = parseFormData(RevokeSchema, formData);
  if (!parsed.ok) return parsed;

  // Das Ergebnis des Wrappers ist der Rückkanal: Rolle, fehlende Vollmacht,
  // bereits widerrufen oder verlorener Lock kommen als { ok: false } beim
  // Client an, der nur bei ok Erfolg meldet.
  return withStaff(
    async (tx, staff) => {
      if (!isStaffAdmin(staff.session)) {
        throw new ActionError('Vollmachten dürfen nur von ADMIN/PARTNER widerrufen werden.');
      }
      await revokePoaTx(tx, staff, parsed.data);
    },
    { modeModule: 'poa', revalidate: ['/staff/poa', `/staff/poa/${parsed.data.poaId}`] },
  );
}
