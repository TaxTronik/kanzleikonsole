'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import {
  ConsentSelectionsSchema,
  emptyConsent,
  countGranted,
  hasConsentRevocation,
  parseConsent,
  type ConsentSelections,
} from '@/server/privacy/consent';
import { resolveConsentSelectionsTx } from '@/server/privacy/consent-catalog';
import { renderNoticeForTenantTx } from '@/server/privacy/service';
import { isPrivacyConfigComplete, readPrivacyConfigTx } from '@/server/privacy/notice';

const SaveSchema = z.object({
  clientId: z.string().uuid(),
  consentsJson: z.string().min(2).max(50_000),
  signedByName: z.string().min(1).max(300),
  signedByContact: z.string().uuid().optional().or(z.literal('')),
  note: z.string().max(2000).optional().or(z.literal('')),
});

export async function saveConsentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = SaveSchema.safeParse({
    clientId: formData.get('clientId'),
    consentsJson: formData.get('consentsJson'),
    signedByName: formData.get('signedByName'),
    signedByContact: formData.get('signedByContact') ?? '',
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler — bitte Eingaben prüfen.' };
  const d = parsed.data;

  let submittedConsents: ConsentSelections;
  try {
    submittedConsents = ConsentSelectionsSchema.parse(JSON.parse(d.consentsJson));
  } catch {
    return { ok: false, error: 'Einwilligungsdaten konnten nicht gelesen werden.' };
  }

  try {
    await withTenantContext(ctx, async (tx) => {
      await assertClientAccessTx(tx, session, d.clientId);
      await assertClientInTenant(tx, d.clientId);
      const consents = await resolveConsentSelectionsTx(tx, tenantId, submittedConsents);
      // Optionaler Kontakt muss zum Mandanten gehören.
      let signedByContact: string | null = null;
      if (d.signedByContact && d.signedByContact !== '') {
        const contact = await tx.clientContact.findFirst({
          where: { id: d.signedByContact, clientId: d.clientId },
          select: { id: true },
        });
        if (!contact)
          throw new Error('Ausgewählte Kontaktperson gehört nicht zu diesem Mandanten.');
        signedByContact = contact.id;
      }

      const privacyConfig = await readPrivacyConfigTx(tx, tenantId);
      if (!isPrivacyConfigComplete(privacyConfig)) {
        throw new Error(
          'Datenschutzhinweis unvollständig: Verantwortliche Stelle, Datenschutzkontakt und Aufsichtsbehörde müssen zuerst konfiguriert werden.',
        );
      }

      const previous = await tx.clientConsent.findFirst({
        where: { clientId: d.clientId },
        select: { consents: true },
        orderBy: { createdAt: 'desc' },
      });
      const isRevocation = previous
        ? hasConsentRevocation(parseConsent(previous.consents), consents)
        : false;

      // Volltext-Snapshot einfrieren (Nachweis der akzeptierten Fassung).
      const notice = await renderNoticeForTenantTx(tx, tenantId);

      const row = await tx.clientConsent.create({
        data: {
          tenantId,
          clientId: d.clientId,
          noticeVersion: notice.version,
          noticeSnapshot: notice.body,
          consents: consents as object,
          source: 'STAFF',
          signedByName: d.signedByName.trim(),
          signedByContact,
          isRevocation,
          note: d.note && d.note !== '' ? d.note : null,
          createdBy: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: isRevocation ? 'privacy.consent.revoke' : 'privacy.consent.grant',
        resourceType: 'client_consent',
        resourceId: row.id,
        after: {
          clientId: d.clientId,
          noticeVersion: notice.version,
          grantedCount: countGranted(consents),
          signedByName: d.signedByName.trim(),
          source: 'STAFF',
          isRevocation,
        },
      });
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Fehler beim Speichern.' };
  }

  revalidatePath(`/staff/clients/${d.clientId}/privacy`);
  return { ok: true };
}

const RevokeSchema = z.object({
  clientId: z.string().uuid(),
  signedByName: z.string().min(1).max(300),
  note: z.string().max(2000).optional().or(z.literal('')),
});

export async function revokeAllConsentAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) throw new Error(g.error);
  const { tenantId, staffId, ctx, session } = g;

  const parsed = RevokeSchema.safeParse({
    clientId: formData.get('clientId'),
    signedByName: formData.get('signedByName'),
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) throw new Error('Validierungsfehler.');
  const d = parsed.data;

  await withTenantContext(ctx, async (tx) => {
    await assertClientAccessTx(tx, session, d.clientId);
    await assertClientInTenant(tx, d.clientId);
    const notice = await renderNoticeForTenantTx(tx, tenantId);
    const row = await tx.clientConsent.create({
      data: {
        tenantId,
        clientId: d.clientId,
        noticeVersion: notice.version,
        noticeSnapshot: notice.body,
        consents: emptyConsent() as object,
        source: 'STAFF',
        signedByName: d.signedByName.trim(),
        isRevocation: true,
        note: d.note && d.note !== '' ? d.note : 'Vollständiger Widerruf',
        createdBy: staffId,
      },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'privacy.consent.revoke',
      resourceType: 'client_consent',
      resourceId: row.id,
      after: { clientId: d.clientId, signedByName: d.signedByName.trim() },
    });
  });

  revalidatePath(`/staff/clients/${d.clientId}/privacy`);
}
