'use server';

import { z } from 'zod';
import { headers } from 'next/headers';
import {
  commitDocumentFromBytes,
  deleteObject,
  MAX_UPLOAD_BYTES,
  type CommitDocumentResult,
} from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { withSystemContext } from '@taxtronik/db';
import { createDocumentWithVersion } from '@/server/documents/upload-helpers';
import { toActionError } from '@/server/auth/rbac';
import { hashInviteToken, prismaOwner } from '@/server/gwg-onboarding/service';
import { checkRateLimit, checkIpOrGlobalLimit, getClientIp } from '@/server/rate-limit';
import { log } from '@/server/logger';
import { notifyMany } from '@/server/notifications/service';
import { ConsentSelectionsSchema, countGranted } from '@/server/privacy/consent';
import { renderNoticeForTenantTx } from '@/server/privacy/service';
import { isPrivacyConfigComplete, readPrivacyConfigTx } from '@/server/privacy/notice';
import {
  claimGwgOnboardingSubmitTx,
  lockGwgOnboardingUploadTx,
  startFreshGwgReviewTx,
} from '@/server/gwg/reverification';

// M4: GwG-Uploads sind enger gecappt als der globale MAX_UPLOAD_BYTES (100 MB).
// Ausweis-Scans sind typischerweise ≤5 MB; 10 MB ist großzügig für hochauflösende
// PDFs. Das base64-Limit entspricht binär ~7.5 MB; binäre Prüfung darunter
// erzwingt die echte Grenze.
const GWG_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
// base64-overhead: 4 chars pro 3 bytes → 10 MB binär = ~13.4 MB base64.
// 14 MB Schema-Limit schützt vor Memory-DOS durch Parsing übergroßer base64.
const GWG_BASE64_MAX_CHARS = 14 * 1024 * 1024;

export interface ActionResult {
  ok: boolean;
  error?: string;
  documentId?: string;
}

class InviteUploadStateChangedError extends Error {}

// ----------------------------------------------------------------------------
// Befund 6: Fehler-Mapping für diesen anonymen (Token-)Endpoint. Rohe Prisma-/
// Storage-Meldungen dürfen nicht an Unauthentifizierte durchgereicht werden.
// Bekannte fachliche Fehler → verständliche deutsche Meldung; alles andere
// läuft durch das zentrale toActionError (generische Meldung + strukturiertes
// Server-Log).
// ----------------------------------------------------------------------------
function toAnonymousActionError(e: unknown): ActionResult {
  const msg = (e as Error)?.message ?? '';
  if (msg.startsWith('INFECTED')) {
    return { ok: false, error: 'Die Datei wurde vom Virenscanner abgewiesen.' };
  }
  if (msg.startsWith('TOO_LARGE')) {
    return { ok: false, error: 'Die Datei ist zu groß.' };
  }
  if (msg.startsWith('SCAN_ERROR')) {
    return {
      ok: false,
      error: 'Der Virenscan ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.',
    };
  }
  if (msg === 'PRIVACY_CONFIG_INCOMPLETE') {
    return {
      ok: false,
      error:
        'Die Datenschutzhinweise der Kanzlei sind noch unvollständig. Bitte wenden Sie sich an die Kanzlei.',
    };
  }
  if (e instanceof InviteUploadStateChangedError) {
    return {
      ok: false,
      error:
        'Die Einladung wurde zwischenzeitlich abgeschlossen oder ist abgelaufen. Die Datei wurde nicht zugeordnet.',
    };
  }
  return toActionError(e);
}

// ----------------------------------------------------------------------------
// Token-Lookup (gemeinsam für Upload + Submit)
// ----------------------------------------------------------------------------

async function loadInviteForWrite(rawToken: string) {
  const tokenHash = hashInviteToken(rawToken);
  const inv = await prismaOwner.gwgOnboardingInvite.findFirst({
    where: { tokenHash },
    include: { client: true },
  });
  if (!inv) throw new Error('Einladung nicht gefunden.');
  if (inv.status === 'CANCELLED' || inv.status === 'EXPIRED') {
    throw new Error('Einladung nicht mehr gültig.');
  }
  if (inv.status === 'SUBMITTED') {
    throw new Error('Bereits abgeschickt.');
  }
  if (inv.expiresAt.getTime() < Date.now()) {
    await prismaOwner.gwgOnboardingInvite.update({
      where: { id: inv.id },
      data: { status: 'EXPIRED' },
    });
    throw new Error('Einladung ist abgelaufen.');
  }
  return inv;
}

// ----------------------------------------------------------------------------
// Datei-Upload (Token-authentifiziert)
// ----------------------------------------------------------------------------

const UploadSchema = z.object({
  token: z.string().min(10),
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  base64: z.string().min(1).max(GWG_BASE64_MAX_CHARS),
  kind: z.enum(['ID_DOCUMENT', 'EXTRA']),
});

export async function uploadIdImageAction(input: {
  token: string;
  fileName: string;
  mimeType: string;
  base64: string;
  kind: 'ID_DOCUMENT' | 'EXTRA';
}): Promise<ActionResult> {
  const parsed = UploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { token, fileName, mimeType, base64, kind } = parsed.data;

  // H2: Rate-Limit gegen Sättigung von Storage + ClamAV-Backend. Pro IP
  // und pro Token getrennt — ein böser Token-Inhaber soll andere Mandanten
  // nicht ausbremsen können, eine bösartige IP nicht mehrere Tokens parallel
  // missbrauchen. 20 Uploads pro 10 Min ist großzügig für ein Onboarding
  // (typisch 4-8 Dateien), aber bremst ein Skript hart.
  const ip = getClientIp(await headers());
  const ipRl = await checkIpOrGlobalLimit(
    'gwg-upload-ip',
    ip,
    { max: 30, windowSec: 600 },
    { max: 200, windowSec: 600 },
  );
  if (!ipRl.ok) {
    return {
      ok: false,
      error: `Zu viele Uploads. Bitte ${Math.ceil(ipRl.retryAfter / 60)} Min. warten.`,
    };
  }
  const tokenRl = await checkRateLimit(`gwg-upload-token:${hashInviteToken(token).slice(0, 16)}`, {
    max: 20,
    windowSec: 600,
  });
  if (!tokenRl.ok) {
    return {
      ok: false,
      error: `Zu viele Uploads für diese Einladung. Bitte ${Math.ceil(tokenRl.retryAfter / 60)} Min. warten.`,
    };
  }

  let invite: Awaited<ReturnType<typeof loadInviteForWrite>>;
  try {
    invite = await loadInviteForWrite(token);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const fileData = Buffer.from(base64, 'base64');
  if (fileData.length > GWG_UPLOAD_MAX_BYTES) {
    return { ok: false, error: `Datei zu groß (max. ${GWG_UPLOAD_MAX_BYTES / (1024 * 1024)} MB).` };
  }
  // Defense in Depth: globaler Cap aus dem Storage-Service spiegelt das
  // Limit von commitDocumentFromBytes. Sollte beim GwG-Pfad nie greifen
  // (GwG-Cap ist enger), aber falls jemand das GwG-Limit hochsetzt ohne
  // den globalen anzupassen, fängt der globale Cap es ab.
  if (fileData.length > MAX_UPLOAD_BYTES) {
    return { ok: false, error: 'Datei überschreitet das globale Upload-Limit.' };
  }

  // Eigene GwG-Klassifikation: reguläre Aufbewahrung fünf Jahre nach § 8 Abs. 4
  // GwG; ausdrücklich nicht pauschal als GoBD-Beleg/10-Jahres-Objekt behandeln.
  const classification = 'GWG_EVIDENCE';

  let documentId: string;
  let stored: CommitDocumentResult | null = null;
  try {
    const committed = await commitDocumentFromBytes({
      fileData,
      classification,
      tenantId: invite.tenantId,
    });
    stored = committed;

    // Dokument + erste Version anlegen — direkt im SYSTEM-Kontext, weil
    // der Mandant keinen Auth-Kontext hat. Audit-Trail via evidence-Service.
    documentId = await withSystemContext(invite.tenantId, async (tx) => {
      const inviteStillOpen = await lockGwgOnboardingUploadTx(tx, {
        inviteId: invite.id,
        tenantId: invite.tenantId,
        clientId: invite.clientId,
        tokenHash: hashInviteToken(token),
        now: new Date(),
      });
      if (!inviteStillOpen) throw new InviteUploadStateChangedError();

      // Befund 12: Document+Version-Insert zentral (upload-helpers).
      const { document: doc } = await createDocumentWithVersion(tx, {
        documentData: {
          tenantId: invite.tenantId,
          clientId: invite.clientId,
          title: fileName,
          classification,
          gwgOnboardingInviteId: invite.id,
          // P-3: detectedMime (Magic-Bytes) hat Vorrang vor dem Client-
          // gemeldeten mimeType. Mandant könnte sonst HTML als image/jpeg
          // hochladen und Browser-Sniffing-Missbrauch im Staff-Preview
          // auslösen.
          mimeType: committed.detectedMime ?? mimeType,
        },
        commit: committed,
        // System-Action: erfasst-für, nicht erfasst-von
        createdById: invite.createdByStaff,
      });
      await evidenceService.record(tx, {
        tenantId: invite.tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: null,
        action: kind === 'ID_DOCUMENT' ? 'gwg.onboarding.upload.id' : 'gwg.onboarding.upload.extra',
        resourceType: 'document',
        resourceId: doc.id,
        after: { fileName, mimeType, inviteId: invite.id, kind },
      });
      // Liste und Document werden zusammen committed, waehrend der Invite bis
      // zum Transaktionsende FOR UPDATE gesperrt bleibt. Ein Submit sieht
      // damit entweder den kompletten Upload oder wartet und laeuft danach.
      await tx.$executeRaw`
        UPDATE gwg_onboarding_invite
        SET uploaded_document_ids = uploaded_document_ids || ${JSON.stringify([doc.id])}::jsonb,
            status = CASE
              WHEN status = 'PENDING'::gwg_invite_status THEN 'STARTED'::gwg_invite_status
              ELSE status
            END
        WHERE id = ${invite.id}::uuid
      `;
      return doc.id;
    });
  } catch (e) {
    if (stored && e instanceof InviteUploadStateChangedError) {
      try {
        await deleteObject(stored.targetBucket, stored.targetKey);
      } catch (cleanupError) {
        log.error(
          {
            component: 'gwg-onboarding-upload',
            inviteId: invite.id,
            tenantId: invite.tenantId,
            orphanedBucket: stored.targetBucket,
            orphanedKey: stored.targetKey,
            cleanupErr: (cleanupError as Error).message,
          },
          'GwG onboarding upload orphan compensation failed',
        );
      }
    }
    // Befund 6: kein Durchreichen roher Prisma-/Storage-Meldungen an Anonyme.
    const err = e as Error;
    log.error(
      {
        component: 'gwg-onboarding-upload',
        kind,
        inviteId: invite.id,
        tenantId: invite.tenantId,
        clientId: invite.clientId,
        mimeType,
        sizeBytes: fileData.length,
        name: err?.name,
        err: err?.message,
        stack: err?.stack,
      },
      'GwG onboarding upload failed',
    );
    return toAnonymousActionError(e);
  }

  return { ok: true, documentId };
}

// ----------------------------------------------------------------------------
// Submit (alle Stammdaten + Owner + Dokumente in GwG-Tabellen schreiben)
// ----------------------------------------------------------------------------

const OwnerSchema = z.object({
  fullName: z.string().min(1).max(200),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // P2-2 / § 11 Abs. 4 Nr. 1 GwG: Geburtsort, Staatsangehörigkeit und
  // Wohnanschrift sind bei natürlichen Personen Pflicht-Identifizierungsdaten.
  birthPlace: z.string().min(1, 'Geburtsort ist Pflicht (§ 11 Abs. 4 GwG).').max(200),
  nationality: z.string().min(1, 'Staatsangehörigkeit ist Pflicht (§ 11 Abs. 4 GwG).').max(50),
  street: z.string().min(1, 'Wohnanschrift (Straße) ist Pflicht (§ 11 Abs. 4 GwG).').max(255),
  postalCode: z.string().min(1, 'Wohnanschrift (PLZ) ist Pflicht.').max(20),
  city: z.string().min(1, 'Wohnanschrift (Ort) ist Pflicht.').max(100),
  countryIso: z.string().max(10).optional().or(z.literal('')),
  sharePercent: z.string().max(50).optional().or(z.literal('')),
  idNumber: z.string().max(100).optional().or(z.literal('')),
  idIssuedBy: z.string().max(200).optional().or(z.literal('')),
  idIssueDate: z.string().date().optional().or(z.literal('')),
  idExpiryDate: z.string().date().optional().or(z.literal('')),
  idFrontDocumentId: z.string().uuid(),
  idBackDocumentId: z.string().uuid(),
});

const SubmitSchema = z.object({
  token: z.string().min(10),
  master: z.object({
    companyName: z.string().min(1).max(200),
    street: z.string().min(1).max(255),
    postalCode: z.string().min(1).max(20),
    city: z.string().min(1).max(100),
    countryIso: z.string().min(2).max(10),
    vatId: z.string().max(20).optional().or(z.literal('')),
  }),
  owners: z.array(OwnerSchema).min(1),
  extraDocumentIds: z.array(z.string().uuid()),
  // Datenschutz-Einwilligungen (Teil B) + Bestätigung der Hinweise (Teil A).
  consent: z.object({
    noticeAcknowledged: z.literal(true),
    signedByName: z.string().min(1).max(300),
    selections: ConsentSelectionsSchema,
  }),
});

export async function submitOnboardingAction(
  input: z.infer<typeof SubmitSchema>,
): Promise<ActionResult> {
  const parsed = SubmitSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const { token, master, owners } = parsed.data;

  const h = await headers();
  const ip = getClientIp(h);
  const ua = h.get('user-agent') ?? null;

  // H2: Rate-Limit auf Submit (≤5/min pro Token) — Spam-Schutz gegen
  // automatisiertes Replay nach Token-Leak.
  const submitRl = await checkRateLimit(`gwg-submit-token:${hashInviteToken(token).slice(0, 16)}`, {
    max: 5,
    windowSec: 60,
  });
  if (!submitRl.ok) {
    return { ok: false, error: 'Zu viele Submit-Versuche. Bitte kurz warten.' };
  }

  let invite: Awaited<ReturnType<typeof loadInviteForWrite>>;
  try {
    invite = await loadInviteForWrite(token);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // H-1: alle referenzierten Document-IDs müssen über DIESES Invite
  // hochgeladen worden sein. Sonst könnte ein Angreifer beim Submit fremde
  // document.id-UUIDs einreihen — FK greift nur auf Existenz, nicht Tenant.
  const allowedDocIds = new Set(
    Array.isArray(invite.uploadedDocumentIds) ? (invite.uploadedDocumentIds as string[]) : [],
  );
  const referencedDocIds: string[] = [
    ...parsed.data.owners.flatMap((o) => [o.idFrontDocumentId, o.idBackDocumentId]),
    ...parsed.data.extraDocumentIds,
  ];
  for (const docId of referencedDocIds) {
    if (!allowedDocIds.has(docId)) {
      return {
        ok: false,
        error: 'Referenziertes Dokument wurde nicht über diesen Onboarding-Link hochgeladen.',
      };
    }
  }

  try {
    await withSystemContext(invite.tenantId, async (tx) => {
      // Atomarer Einmal-Claim als ERSTE Mutation derselben Transaktion. Zwei
      // parallele Requests duerfen nicht zwei Reviews, Einwilligungen und
      // Identitaetssnapshots fuer dieselbe Einladung erzeugen. Bei jedem
      // spaeteren Fehler rollt PostgreSQL auch diesen Claim vollstaendig zurueck.
      const submittedAt = new Date();
      const claimed = await claimGwgOnboardingSubmitTx(tx, {
        inviteId: invite.id,
        tokenHash: hashInviteToken(token),
        submittedAt,
        submittedIp: ip,
        submittedUa: ua,
      });
      if (!claimed) {
        throw new Error(
          'Einladung wurde bereits abgeschickt, ist abgelaufen oder nicht mehr gueltig.',
        );
      }

      const privacyConfig = await readPrivacyConfigTx(tx, invite.tenantId);
      if (!isPrivacyConfigComplete(privacyConfig)) {
        throw new Error('PRIVACY_CONFIG_INCOMPLETE');
      }
      // 1. Client-Stammdaten ggf. updaten — und welche Felder geändert wurden
      const before = {
        name: invite.client.name,
        street: invite.client.street,
        postalCode: invite.client.postalCode,
        city: invite.client.city,
        countryIso: invite.client.countryIso,
        vatId: invite.client.vatId,
      };
      const after = {
        name: master.companyName.trim(),
        street: master.street.trim(),
        postalCode: master.postalCode.trim(),
        city: master.city.trim(),
        countryIso: master.countryIso.trim(),
        vatId: master.vatId?.trim() || null,
      };
      const changedFields: string[] = [];
      for (const k of ['name', 'street', 'postalCode', 'city', 'countryIso', 'vatId'] as const) {
        if (before[k] !== after[k]) changedFields.push(k);
      }
      if (changedFields.length > 0) {
        await tx.client.update({ where: { id: invite.clientId }, data: after });
      }

      // 2. GwG-Check anlegen oder bestehenden auf IN_REVIEW setzen
      const review = await startFreshGwgReviewTx(tx, {
        tenantId: invite.tenantId,
        clientId: invite.clientId,
      });
      const checkId = review.reviewCheckId;

      // 2b. Datenschutz-Einwilligungen (Teil B) persistieren + Hinweis-Snapshot
      // einfrieren. Leere Array-Zeilen verwerfen. source=PORTAL, kein Staff.
      const sel = parsed.data.consent.selections;
      sel.thirdParties = sel.thirdParties.filter((t) => t.recipient.trim() !== '');
      sel.specialists = sel.specialists.filter((s) => s.entity.trim() !== '');
      const notice = await renderNoticeForTenantTx(tx, invite.tenantId);
      const consentRow = await tx.clientConsent.create({
        data: {
          tenantId: invite.tenantId,
          clientId: invite.clientId,
          noticeVersion: notice.version,
          noticeSnapshot: notice.body,
          consents: sel as object,
          source: 'PORTAL',
          signedByName: parsed.data.consent.signedByName.trim(),
          isRevocation: false,
          note: 'Über GwG-Onboarding-Portal erteilt',
          createdBy: null,
        },
      });
      await evidenceService.record(tx, {
        tenantId: invite.tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: null,
        action: 'privacy.consent.grant',
        resourceType: 'client_consent',
        resourceId: consentRow.id,
        after: {
          clientId: invite.clientId,
          noticeVersion: notice.version,
          grantedCount: countGranted(sel),
          signedByName: parsed.data.consent.signedByName.trim(),
          source: 'PORTAL',
        },
      });

      // 3. Wirtschaftlich Berechtigte erfassen
      // Bestehende für diesen Check aufräumen — Mandant gibt aktuelle Liste vor.
      // Bestehende ID-Documents (für diesen Check) aufräumen.

      for (const o of owners) {
        // Adresse als residence-Freitext zusammensetzen
        const residenceParts = [
          o.street?.trim(),
          [o.postalCode?.trim(), o.city?.trim()].filter(Boolean).join(' '),
          o.countryIso?.trim(),
        ].filter(Boolean);
        const residence = residenceParts.length > 0 ? residenceParts.join(', ') : null;

        // sharePercent als Decimal parsen, sonst in notes lassen
        const shareMatch = (o.sharePercent ?? '').match(/(\d+(?:[.,]\d+)?)/);
        const ownershipPct = shareMatch ? Number(shareMatch[1]!.replace(',', '.')) : null;
        const noteParts: string[] = [];
        if (o.sharePercent && !ownershipPct) noteParts.push(`Anteil: ${o.sharePercent.trim()}`);
        const notes = noteParts.length > 0 ? noteParts.join(' · ') : null;

        await tx.gwgBeneficialOwner.create({
          data: {
            gwgCheckId: checkId,
            fullName: o.fullName.trim(),
            birthDate: new Date(o.birthDate + 'T00:00:00.000Z'),
            birthPlace: o.birthPlace?.trim() || null,
            nationality: o.nationality?.trim() || null,
            residence,
            ownershipPct,
            notes,
          },
        });
        // Vorder + Rückseite als zwei GwgIdDocument-Einträge
        await tx.gwgIdDocument.create({
          data: {
            gwgCheckId: checkId,
            type: 'PERSONALAUSWEIS',
            ownerName: o.fullName.trim(),
            documentId: o.idFrontDocumentId,
            number: o.idNumber?.trim() || null,
            issuedBy: o.idIssuedBy?.trim() || null,
            issueDate: o.idIssueDate ? new Date(o.idIssueDate + 'T00:00:00.000Z') : null,
            expiryDate: o.idExpiryDate ? new Date(o.idExpiryDate + 'T00:00:00.000Z') : null,
            notes: 'Vorderseite (durch Mandant hochgeladen)',
          },
        });
        await tx.gwgIdDocument.create({
          data: {
            gwgCheckId: checkId,
            type: 'PERSONALAUSWEIS',
            ownerName: o.fullName.trim(),
            documentId: o.idBackDocumentId,
            number: o.idNumber?.trim() || null,
            issuedBy: o.idIssuedBy?.trim() || null,
            issueDate: o.idIssueDate ? new Date(o.idIssueDate + 'T00:00:00.000Z') : null,
            expiryDate: o.idExpiryDate ? new Date(o.idExpiryDate + 'T00:00:00.000Z') : null,
            notes: 'Rückseite (durch Mandant hochgeladen)',
          },
        });
      }

      // 4. Den bereits atomar beanspruchten Invite mit seinem frischen Check
      // verknuepfen. Status/Submit-Nachweise wurden beim Claim gesetzt.
      await tx.gwgOnboardingInvite.update({
        where: { id: invite.id },
        data: {
          gwgCheckId: checkId,
        },
      });

      // 5. Audit-Trail
      await evidenceService.record(tx, {
        tenantId: invite.tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: null,
        action: 'gwg.onboarding.submit',
        resourceType: 'gwg_onboarding_invite',
        resourceId: invite.id,
        before,
        after: {
          ...after,
          changedFields,
          ownerCount: owners.length,
          gwgCheckId: checkId,
          invalidatedChecks: review.invalidatedChecks,
          clientDeactivated: review.clientDeactivated,
        },
        ip,
        userAgent: ua,
      });
      if (changedFields.length > 0) {
        await evidenceService.record(tx, {
          tenantId: invite.tenantId,
          actorType: 'CLIENT_CONTACT',
          actorId: null,
          action: 'client.update.gwg_relevant',
          resourceType: 'client',
          resourceId: invite.clientId,
          before,
          after: { ...after, _changedFields: changedFields, _via: 'gwg_onboarding' },
          ip,
          userAgent: ua,
        });
      }

      const responsibilities = await tx.clientResponsibility.findMany({
        where: { clientId: invite.clientId, role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
        select: { staffId: true },
      });
      const staffIds = Array.from(new Set(responsibilities.map((r) => r.staffId)));
      try {
        await notifyMany(tx, staffIds.length > 0 ? staffIds : [null], {
          tenantId: invite.tenantId,
          kind: 'GWG_ONBOARDING_SUBMITTED',
          title: 'GwG-Onboarding eingereicht',
          body: `${after.name} hat GwG-Angaben und Unterlagen übermittelt.`,
          href: `/staff/clients/${invite.clientId}/gwg`,
          resourceType: 'gwg_onboarding_invite',
          resourceId: invite.id,
        });
      } catch (e) {
        log.error(
          {
            component: 'gwg-onboarding-submit',
            inviteId: invite.id,
            tenantId: invite.tenantId,
            clientId: invite.clientId,
            name: (e as Error)?.name,
            err: (e as Error)?.message,
          },
          'GwG onboarding submit notification failed',
        );
      }
    });
  } catch (e) {
    // Befund 6: kein Durchreichen roher Prisma-/DB-Meldungen an Anonyme.
    return toAnonymousActionError(e);
  }

  return { ok: true };
}
