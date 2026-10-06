// =============================================================================
// Versand einer Vollmacht zur Unterschrift (Review-Finding K-03).
//
// Fachkatalog: POA-LIFECYCLE-001, POA-SIGNING-SNAPSHOT-001,
// POA-SIGNING-CONFIRMATION-001
//
// Ablauf (sendPoaForSignature):
//   1. Signatur-Token erzeugen — der Klartext steht nur im Link, die
//      Datenbank erhält Hash und Ablauf
//   2. claimPoaForSignatureTx in EINER Transaktion: Vollmacht und Zugriff
//      prüfen, Dokument sperren, Versandsnapshot binden, atomar claimen,
//      auditieren
//   3. dispatchPoaSigningMail: Einladung mit Link versenden
// Das ADMIN/PARTNER-Gate (Berufsträger) bleibt in der Action.
// =============================================================================

import { withTenantContext, type TxClient } from '@taxtronik/db';
import { portalBaseUrl } from '@taxtronik/config';
import { evidenceService } from '@/server/container';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { assertClientAccessTx, toActionError, type ActionErrorResult } from '@/server/auth/rbac';
import { ActionError, type StaffCtx } from '@/server/actions/staff-action';
import { buildPoaSigningSnapshot, isPoaExpired } from '@/server/poa/signing-snapshot';
import { SIGNING_TOKEN_TTL_HOURS, issueSigningToken } from '@/server/poa/signing-token';

export interface SendPoaForSignatureInput {
  poaId: string;
  /** Seitenstand (updatedAt) beim Absenden; ein paralleler Wechsel gewinnt. */
  expectedUpdatedAt: Date;
}

/** Was die Einladung aus der geclaimten Vollmacht und dem Tenant braucht. */
export interface ClaimedPoaSignature {
  poa: { clientId: string; signerEmail: string; signerName: string; subject: string };
  tenantName: string;
}

/**
 * Prüft die Vollmacht, bindet den Versandsnapshot und setzt sie atomar auf
 * SENT (neuer Signatur-Token = neuer Lebenszyklus, beide Fehlversuchszähler 0).
 */
export async function claimPoaForSignatureTx(
  tx: TxClient,
  { tenantId, staffId, session }: Pick<StaffCtx, 'tenantId' | 'staffId' | 'session'>,
  { poaId, expectedUpdatedAt }: SendPoaForSignatureInput,
  { tokenHash, expiresAt }: { tokenHash: string; expiresAt: Date },
): Promise<ClaimedPoaSignature> {
  const before = await tx.powerOfAttorney.findUnique({ where: { id: poaId } });
  if (!before) throw new ActionError('Vollmacht nicht gefunden.');
  // Vertraulich-/RESTRICTED-Ventil.
  await assertClientAccessTx(tx, session, before.clientId);
  if (before.status === 'SIGNED') throw new ActionError('Bereits unterschrieben.');
  if (before.status === 'REVOKED') throw new ActionError('Vollmacht ist widerrufen.');
  if (before.status === 'EXPIRED' || isPoaExpired(before.validUntil)) {
    throw new ActionError('Die Vollmacht ist abgelaufen und kann nicht mehr versendet werden.');
  }

  const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new ActionError('Mandant fehlt.');

  if (before.documentId) {
    // Serialisiert Versand gegen den finalen Insert einer neuen Version.
    // Gewinnt der Upload, bindet der Snapshot danach dessen neue Version;
    // gewinnt der Versand, sieht der Upload nach dem Lock den SENT-Status.
    await tx.$queryRaw`
      SELECT id FROM document
      WHERE id = ${before.documentId}::uuid
      FOR UPDATE
    `;
  }
  const documentVersion = before.documentId
    ? await tx.documentVersion.findFirst({
        where: { documentId: before.documentId },
        orderBy: { versionNo: 'desc' },
        select: { id: true, documentId: true, sha256: true },
      })
    : null;
  if (before.documentId && !documentVersion) {
    throw new ActionError('Das zu unterzeichnende Dokument hat keine gültige Version.');
  }
  const signingSnapshot = buildPoaSigningSnapshot({
    subject: before.subject,
    signerName: before.signerName,
    signerEmail: before.signerEmail,
    validFrom: before.validFrom,
    validUntil: before.validUntil,
    scope: before.scope,
    document: documentVersion
      ? {
          documentId: documentVersion.documentId,
          versionId: documentVersion.id,
          sha256: documentVersion.sha256,
        }
      : null,
  });

  // TOCTOU-Schutz: atomarer Claim. Race gegen signPoaAction — ein paralleler
  // Abschluss (→ SIGNED) darf nicht durch ein Re-Send auf SENT zurückgesetzt
  // werden (sonst frischer Signing-Token für eine bereits signierte
  // Vollmacht → Beweisspur beschädigt).
  const claim = await tx.powerOfAttorney.updateMany({
    where: {
      id: poaId,
      status: { in: ['DRAFT', 'SENT'] },
      updatedAt: expectedUpdatedAt,
    },
    data: {
      status: 'SENT',
      signingTokenHash: tokenHash,
      signingTokenExpiresAt: expiresAt,
      // Etwaiges OTP zurücksetzen. Neuer Signatur-Token = neuer
      // Lebenszyklus → beide Fehlversuchszähler auf 0 (Audit 2026-06
      // Befund 2: der Total-Zähler wird NUR hier zurückgesetzt, nie
      // beim OTP-Re-Issue).
      signingOtpHash: null,
      signingOtpExpiresAt: null,
      signingOtpAttempts: 0,
      signingOtpAttemptsTotal: 0,
      signingContentSnapshot: signingSnapshot.serialized,
      signingContentSha256: prismaBytes(signingSnapshot.sha256),
      signingDocumentVersionId: documentVersion?.id ?? null,
    },
  });
  if (claim.count === 0) {
    throw new ActionError('Status wurde zwischenzeitlich geändert — bitte Seite neu laden.');
  }
  const updated = await tx.powerOfAttorney.findUniqueOrThrow({ where: { id: poaId } });

  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'poa.send',
    resourceType: 'power_of_attorney',
    resourceId: poaId,
    after: {
      signerEmail: before.signerEmail,
      contentSha256: signingSnapshot.sha256.toString('hex'),
      documentVersionId: documentVersion?.id ?? null,
    },
  });

  return { poa: updated, tenantName: tenant.name };
}

/** Versendet die Signatur-Einladung; false, wenn die Mail nicht zugestellt wurde. */
export async function dispatchPoaSigningMail(
  tenantId: string,
  rawToken: string,
  { poa, tenantName }: ClaimedPoaSignature,
): Promise<boolean> {
  const link = `${portalBaseUrl}/poa/sign?token=${encodeURIComponent(rawToken)}`;
  const delivery = await sendTemplateMail({
    tenantId,
    clientId: poa.clientId,
    slug: 'poa-sign',
    to: poa.signerEmail,
    vars: {
      contact: { fullName: poa.signerName, email: poa.signerEmail },
      client: { name: tenantName },
      subject: poa.subject,
      link,
      expiresHours: SIGNING_TOKEN_TTL_HOURS,
    },
    fallback: {
      subject: 'Bitte Vollmacht signieren — {{client.name}}',
      bodyMd:
        'Sehr geehrte/r {{contact.fullName}},\n\nbitte signieren Sie die anliegende Vollmacht über folgenden Link:\n\n{{link}}\n\nDer Link ist {{expiresHours}} Stunden gültig.',
    },
  });
  return delivery.ok;
}

export type SendPoaForSignatureResult = { ok: true } | ActionErrorResult;

/** Token erzeugen → Claim-Transaktion → Einladung (siehe Kopfkommentar). */
export async function sendPoaForSignature(
  g: StaffCtx,
  input: SendPoaForSignatureInput,
): Promise<SendPoaForSignatureResult> {
  // Token im Klartext, Hash in DB
  const { rawToken, tokenHash, expiresAt } = issueSigningToken();

  let claimed: ClaimedPoaSignature;
  try {
    claimed = await withTenantContext(g.ctx, (tx) =>
      claimPoaForSignatureTx(tx, g, input, { tokenHash, expiresAt }),
    );
  } catch (e) {
    return toActionError(e);
  }

  if (!(await dispatchPoaSigningMail(g.tenantId, rawToken, claimed))) {
    return {
      ok: false,
      error:
        'Die Vollmacht wurde vorbereitet, die E-Mail konnte aber nicht zugestellt werden. Bitte Seite neu laden und erneut senden.',
    };
  }
  return { ok: true };
}
