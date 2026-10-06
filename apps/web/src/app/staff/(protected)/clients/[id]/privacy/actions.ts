'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { ActionError, staffAction, type ActionResult } from '@/server/actions/staff-action';
import { formDefault, parseFormData } from '@/server/actions/form-data';
import {
  ConsentSelectionsSchema,
  countGranted,
  countRevocableGranted,
  hasConsentRevocation,
  parseConsent,
  revokeVoluntaryConsent,
  type ConsentSelections,
} from '@/server/privacy/consent';
import { resolveConsentSelectionsTx } from '@/server/privacy/consent-catalog';
import { renderNoticeForTenantTx } from '@/server/privacy/service';
import { isPrivacyConfigComplete, readPrivacyConfigTx } from '@/server/privacy/notice';
import { audit } from '@/server/actions/audit';

const SaveSchema = z.object({
  clientId: z.string().uuid(),
  consentsJson: z.string().min(2).max(50_000),
  signedByName: z.string().min(1).max(300),
  signedByContact: formDefault('', z.string().uuid().optional().or(z.literal(''))),
  note: formDefault('', z.string().max(2000).optional().or(z.literal(''))),
});

export async function saveConsentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    run: async ({ tenantId, staffId, ctx, session }) => {
      const parsed = parseFormData(SaveSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler — bitte Eingaben prüfen.',
      });
      if (!parsed.ok) return parsed;
      const d = parsed.data;

      let rawConsents: unknown;
      try {
        rawConsents = JSON.parse(d.consentsJson);
      } catch {
        rawConsents = undefined;
      }
      const consentsInput = ConsentSelectionsSchema.safeParse(rawConsents);
      if (!consentsInput.success) {
        return { ok: false, error: 'Einwilligungsdaten konnten nicht gelesen werden.' };
      }
      const submittedConsents: ConsentSelections = consentsInput.data;

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
            throw new ActionError('Ausgewählte Kontaktperson gehört nicht zu diesem Mandanten.');
          signedByContact = contact.id;
        }

        const privacyConfig = await readPrivacyConfigTx(tx, tenantId);
        if (!isPrivacyConfigComplete(privacyConfig)) {
          throw new ActionError(
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
        await audit(tx, ctx, {
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

      revalidatePath(`/staff/clients/${d.clientId}/privacy`);
    },
  });
}

const RevokeSchema = z.object({
  clientId: z.string().uuid(),
  signedByName: z.string().min(1).max(300),
  note: formDefault('', z.string().max(2000).optional().or(z.literal(''))),
});

export async function revokeAllConsentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    run: async ({ tenantId, staffId, ctx, session }) => {
      const parsed = parseFormData(RevokeSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;
      const d = parsed.data;

      await withTenantContext(ctx, async (tx) => {
        await assertClientAccessTx(tx, session, d.clientId);
        await assertClientInTenant(tx, d.clientId);
        const previous = await tx.clientConsent.findFirst({
          where: { clientId: d.clientId },
          select: { consents: true },
          orderBy: { createdAt: 'desc' },
        });
        if (!previous) return;
        const previousConsent = parseConsent(previous.consents);
        const revokedCount = countRevocableGranted(previousConsent);
        if (revokedCount === 0) return;
        const notice = await renderNoticeForTenantTx(tx, tenantId);
        const row = await tx.clientConsent.create({
          data: {
            tenantId,
            clientId: d.clientId,
            noticeVersion: notice.version,
            noticeSnapshot: notice.body,
            consents: revokeVoluntaryConsent(previousConsent) as object,
            source: 'STAFF',
            signedByName: d.signedByName.trim(),
            isRevocation: true,
            note: d.note && d.note !== '' ? d.note : 'Widerruf freiwilliger Einwilligungen',
            createdBy: staffId,
          },
        });
        await audit(tx, ctx, {
          action: 'privacy.consent.revoke',
          resourceType: 'client_consent',
          resourceId: row.id,
          after: { clientId: d.clientId, signedByName: d.signedByName.trim(), revokedCount },
        });
      });

      revalidatePath(`/staff/clients/${d.clientId}/privacy`);
    },
  });
}
