'use server';

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { portalBaseUrl } from '@taxtronik/config';
import { prismaOwner } from '@/server/db/prisma-owner';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { checkRateLimit, checkIpOrGlobalLimit, getClientIp } from '@/server/rate-limit';
import { isStaffAdmin, toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { headers } from 'next/headers';
import { staffActionGuard, withStaff, ActionError } from '@/server/actions/staff-action';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { readModules } from '@/server/settings/modules';
import {
  commitBytesWithTier,
  MAX_UPLOAD_BYTES,
  type CommitDocumentResult,
} from '@taxtronik/storage';
import { createDocumentWithVersion } from '@/server/documents/upload-helpers';
import { notify } from '@/server/notifications/service';
import {
  buildPoaSigningSnapshot,
  isPoaExpired,
  readPoaSigningSnapshot,
  snapshotDocumentMatches,
} from '@/server/poa/signing-snapshot';

const SIGNING_TOKEN_TTL_HOURS = 72;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

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
}

export async function createPoaAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return { ok: false, error: g.error };
  const { tenantId, staffId, ctx, session } = g;

  // R-4: Vollmachtserteilung ist berufsrechtlich eine Erklärung des
  // Steuerberaters (§§ 3 ff. StBerG) — der Berufsträger trägt die Haftung.
  // Ein Sachbearbeiter ohne Bestellung darf das technisch nicht auslösen
  // können. ADMIN/PARTNER (in der Praxis: Kanzleileitung + Partner =
  // Berufsträger) als Gate. Für 4-Augen-Workflow später separater Schritt.
  if (!isStaffAdmin(session)) {
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
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
  }

  const data = parsed.data;

  const modules = await readModules(ctx);
  const externMode = modules.poaMode === 'PDF_TEMPLATE';

  // Scope: Im In-App-Modus (MARKDOWN_OTP) Pflicht (Inline-Text). Im Extern-
  // Modus wird kein Inline-Text gepflegt — das DB-Pflichtfeld bekommt einen
  // Deskriptor, der klar macht, dass die echte Vollmacht als PDF hinterlegt ist.
  const scopeRaw = (data.scope ?? '').trim();
  if (!externMode && !scopeRaw) {
    return { ok: false, error: 'Umfang (Markdown) ist im In-App-Modus Pflicht.' };
  }
  const scope = externMode ? '— Extern als PDF hinterlegt —' : scopeRaw;

  // Extern-Modus: Vollmachts-PDF direkt bei der Anlage hochladen. Nutzer-Upload
  // → ClamAV-Scan bleibt aktiv (anders als bei app-generierten Bytes).
  let pdfCommit: CommitDocumentResult | null = null;
  if (externMode) {
    const file = formData.get('poaPdf');
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: 'Bitte eine PDF-Datei hochladen.' };
    }
    if (file.type !== 'application/pdf') {
      return { ok: false, error: 'Nur PDF-Dateien erlaubt.' };
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `PDF zu groß (max. ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`,
      };
    }
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      pdfCommit = await commitBytesWithTier({ fileData: buf, tier: 'GOBD', tenantId });
    } catch (e) {
      return { ok: false, error: `Upload fehlgeschlagen: ${(e as Error).message}` };
    }
  }

  let id: string;
  try {
    id = await withTenantContext(ctx, async (tx) => {
      // clientId kommt aus dem Formular — Existenz im aktuellen Tenant prüfen
      // (RLS-aware), bevor der FK-Insert eine fremde UUID akzeptieren würde.
      await assertClientInTenant(tx, data.clientId);
      // signerContactId muss zum gewählten Mandanten gehören — sonst ließe
      // sich ein fremder Kontakt als Unterzeichner verknüpfen.
      if (data.signerContactId) {
        const contact = await tx.clientContact.findFirst({
          where: { id: data.signerContactId, clientId: data.clientId },
          select: { id: true },
        });
        if (!contact) {
          throw new ActionError('Ansprechpartner gehört nicht zum gewählten Mandanten.');
        }
      }
      // Extern-Modus: Document + erste Version aus dem Upload anlegen und am
      // POA-Datensatz verknüpfen (documentId).
      let documentId: string | null = null;
      if (pdfCommit) {
        const { document } = await createDocumentWithVersion(tx, {
          documentData: {
            tenantId,
            clientId: data.clientId,
            title: `Vollmacht - ${data.subject}`,
            classification: 'GOBD_CONTRACT',
            mimeType: 'application/pdf',
          },
          commit: pdfCommit,
          createdById: staffId,
        });
        documentId = document.id;
      }
      const poa = await tx.powerOfAttorney.create({
        data: {
          tenantId,
          clientId: data.clientId,
          signerContactId: data.signerContactId || null,
          signerEmail: data.signerEmail.toLowerCase(),
          signerName: data.signerName,
          subject: data.subject,
          scope,
          validFrom: new Date(data.validFrom),
          validUntil: data.validUntil ? new Date(data.validUntil) : null,
          status: 'DRAFT',
          createdByStaff: staffId,
          documentId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'poa.create',
        resourceType: 'power_of_attorney',
        resourceId: poa.id,
        after: {
          subject: data.subject,
          signerEmail: data.signerEmail,
          externMode,
          withPdf: !!documentId,
        },
      });
      return poa.id;
    });
  } catch (e) {
    if (e instanceof ActionError) return { ok: false, error: e.message };
    return { ok: false, error: 'Anlegen fehlgeschlagen.' };
  }

  revalidatePath('/staff/poa');
  redirect(`/staff/poa/${id}`);
}

const SendSchema = z.object({ poaId: z.string().uuid() });

export async function sendForSignatureAction(formData: FormData): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  if (!isStaffAdmin(g.session)) {
    return {
      ok: false,
      error: 'Vollmachten dürfen nur von ADMIN/PARTNER zur Unterschrift versendet werden.',
    };
  }

  const parsed = SendSchema.safeParse({ poaId: formData.get('poaId') });
  if (!parsed.success) return { ok: false, error: 'Ungültig.' };

  const { poaId } = parsed.data;

  // Token im Klartext, Hash in DB
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SIGNING_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  let sent: {
    poa: Awaited<ReturnType<typeof prismaOwner.powerOfAttorney.update>>;
    tenantName: string;
  };
  try {
    sent = await withTenantContext(ctx, async (tx) => {
      const before = await tx.powerOfAttorney.findUnique({ where: { id: poaId } });
      if (!before) throw new ActionError('Vollmacht nicht gefunden.');
      // Vertraulich-/RESTRICTED-Ventil.
      await assertClientAccessTx(tx, g.session, before.clientId);
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
        where: { id: poaId, status: { in: ['DRAFT', 'SENT'] } },
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
    });
  } catch (e) {
    return toActionError(e);
  }

  const link = `${portalBaseUrl}/poa/sign?token=${encodeURIComponent(rawToken)}`;
  await sendTemplateMail({
    tenantId,
    slug: 'poa-sign',
    to: sent.poa.signerEmail,
    vars: {
      contact: { fullName: sent.poa.signerName, email: sent.poa.signerEmail },
      client: { name: sent.tenantName },
      subject: sent.poa.subject,
      link,
      expiresHours: SIGNING_TOKEN_TTL_HOURS,
    },
    fallback: {
      subject: 'Bitte Vollmacht signieren — {{client.name}}',
      bodyMd:
        'Sehr geehrte/r {{contact.fullName}},\n\nbitte signieren Sie die anliegende Vollmacht über folgenden Link:\n\n{{link}}\n\nDer Link ist {{expiresHours}} Stunden gültig.',
    },
  });

  revalidatePath('/staff/poa');
  revalidatePath(`/staff/poa/${poaId}`);
  return { ok: true };
}

const RevokeSchema = z.object({
  poaId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
});

export async function revokePoaAction(formData: FormData): Promise<void> {
  const parsed = RevokeSchema.safeParse({
    poaId: formData.get('poaId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return;

  await withStaff(
    async (tx, { tenantId, staffId, session }) => {
      if (!isStaffAdmin(session)) {
        throw new ActionError('Vollmachten dürfen nur von ADMIN/PARTNER widerrufen werden.');
      }
      const before = await tx.powerOfAttorney.findUnique({
        where: { id: parsed.data.poaId },
        select: { clientId: true, status: true },
      });
      if (!before) throw new ActionError('Vollmacht nicht gefunden.');
      await assertClientAccessTx(tx, session, before.clientId);
      if (before.status === 'REVOKED') throw new ActionError('Bereits widerrufen.');
      const updated = await tx.powerOfAttorney.update({
        where: { id: parsed.data.poaId },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedReason: parsed.data.reason,
          // Token entwerten
          signingTokenHash: null,
          signingOtpHash: null,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'poa.revoke',
        resourceType: 'power_of_attorney',
        resourceId: updated.id,
        after: { reason: parsed.data.reason },
      });
    },
    { revalidate: ['/staff/poa', `/staff/poa/${parsed.data.poaId}`] },
  );
}

// ----- Public sign-flow (kein Auth) ------------------------------------------

// Anti-Enumeration (N5): einheitliche Fehlermeldung über alle
// Lebenszyklus-Phasen hinweg. Token-Hashes sind 32 Byte, Brute-Force
// praktisch ausgeschlossen — aber Defense in Depth gegen
// Information-Disclosure. Modul-Scope, damit auch der Rate-Limit-Pfad
// dieselbe Meldung liefert (kein Token-Probing-Orakel).
const GENERIC_TOKEN_ERROR = 'Link ungültig oder abgelaufen. Bitte fordern Sie einen neuen Link an.';

export async function loadPoaForSigning(rawToken: string): Promise<
  | {
      ok: true;
      poa: {
        id: string;
        subject: string;
        scope: string;
        signerName: string;
        signerEmail: string;
        validFrom: Date;
        validUntil: Date | null;
        status: string;
        documentId: string | null;
      };
      tenantName: string;
    }
  | { ok: false; error: string }
> {
  if (!rawToken) return { ok: false, error: 'Kein Token in der URL.' };

  // Rate-Limit für den unauthentifizierten Token-Lookup (analog
  // gwg-onboarding/page.tsx): die Funktion ist via /poa/sign UND als Server-
  // Action direkt erreichbar — pro IP 30 Validierungen / 10 min. Bei
  // Überschreitung DIESELBE generische Meldung wie bei ungültigem Token.
  const loadIp = getClientIp(await headers());
  const loadRl = await checkIpOrGlobalLimit(
    'poa-load',
    loadIp,
    { max: 30, windowSec: 600 },
    { max: 200, windowSec: 600 },
  );
  if (!loadRl.ok) return { ok: false, error: GENERIC_TOKEN_ERROR };

  const tokenHash = hashToken(rawToken);

  const owner = prismaOwner;

  try {
    const poa = await owner.powerOfAttorney.findFirst({
      where: { signingTokenHash: tokenHash },
    });
    if (!poa) return { ok: false, error: GENERIC_TOKEN_ERROR };
    if (!poa.signingTokenExpiresAt || poa.signingTokenExpiresAt < new Date()) {
      return { ok: false, error: GENERIC_TOKEN_ERROR };
    }
    if (poa.status !== 'SENT' || isPoaExpired(poa.validUntil)) {
      return { ok: false, error: GENERIC_TOKEN_ERROR };
    }
    const snapshot = readPoaSigningSnapshot(poa.signingContentSnapshot, poa.signingContentSha256);
    if (!snapshot || isPoaExpired(snapshot.validUntil)) {
      return { ok: false, error: GENERIC_TOKEN_ERROR };
    }
    if ((snapshot.document?.versionId ?? null) !== poa.signingDocumentVersionId) {
      return { ok: false, error: GENERIC_TOKEN_ERROR };
    }
    const documentVersion = snapshot.document
      ? await owner.documentVersion.findFirst({
          where: {
            id: snapshot.document.versionId,
            documentId: snapshot.document.documentId,
          },
          select: { id: true, documentId: true, sha256: true },
        })
      : null;
    if (!snapshotDocumentMatches(snapshot, documentVersion)) {
      return { ok: false, error: GENERIC_TOKEN_ERROR };
    }
    const tenant = await owner.tenant.findUnique({ where: { id: poa.tenantId } });
    return {
      ok: true,
      poa: {
        id: poa.id,
        subject: snapshot.subject,
        scope: snapshot.scope ?? '',
        signerName: snapshot.signerName,
        signerEmail: snapshot.signerEmail,
        validFrom: new Date(`${snapshot.validFrom}T00:00:00.000Z`),
        validUntil: snapshot.validUntil ? new Date(`${snapshot.validUntil}T00:00:00.000Z`) : null,
        status: poa.status,
        documentId: snapshot.document?.documentId ?? null,
      },
      tenantName: tenant?.name ?? 'Ihre Kanzlei',
    };
  } finally {
    // Singleton: kein $disconnect — Connection wird wiederverwendet.
  }
}

const SIGNING_OTP_TTL_MINUTES = 10;

/**
 * Schritt 2: Anfordern eines zusätzlichen E-Mail-Codes für die Signatur.
 * Sendet einen 6-stelligen Code per Mail an die hinterlegte Adresse.
 */
export async function requestSigningOtpAction(input: {
  rawToken: string;
  consentAccepted: boolean;
}): Promise<ActionResult> {
  const parsedInput = z
    .object({ rawToken: z.string().min(1).max(500), consentAccepted: z.literal(true) })
    .safeParse(input);
  if (!parsedInput.success) {
    return { ok: false, error: 'Bitte bestätigen Sie den Vollmachtsinhalt ausdrücklich.' };
  }
  const { rawToken } = parsedInput.data;
  const tokenHash = hashToken(rawToken);

  // N4: Rate-Limit pro Token gegen Mail-Bombing + OTP-Invalidation-Race.
  // 3 Anforderungen pro 15 Minuten reichen für legitime Re-Sends (vergessene
  // Mail, Code abgelaufen). Mehr ist verdächtig.
  const rl = await checkRateLimit(`poa-otp-req:${tokenHash.slice(0, 16)}`, {
    max: 3,
    windowSec: 15 * 60,
  });
  if (!rl.ok) {
    return {
      ok: false,
      error: `Zu viele Anfragen. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.`,
    };
  }

  // N-5: Hard-Cap pro Token-Lebenszyklus. Der 15-min-Sliding-Window oben deckelt
  // Burst-Anfragen, lässt aber über 72 h Token-TTL ~864 OTP-Issues zu. Mit
  // einem zweiten Limiter über die volle Token-TTL kommen pro Token maximal
  // 10 OTP-Mails raus — verhindert „Smurf-Brute-Force" durch viele Cycles.
  const hardCap = await checkRateLimit(`poa-otp-cap:${tokenHash.slice(0, 16)}`, {
    max: 10,
    windowSec: SIGNING_TOKEN_TTL_HOURS * 60 * 60,
  });
  if (!hardCap.ok) {
    return {
      ok: false,
      error:
        'OTP-Limit für diesen Link erreicht. Bitte beim Steuerberater eine neue Signatur-Einladung anfordern.',
    };
  }

  const owner = prismaOwner;

  try {
    const poa = await owner.powerOfAttorney.findFirst({ where: { signingTokenHash: tokenHash } });
    if (!poa) return { ok: false, error: 'Token ungültig.' };
    if (!poa.signingTokenExpiresAt || poa.signingTokenExpiresAt < new Date()) {
      return { ok: false, error: 'Token abgelaufen.' };
    }
    if (poa.status !== 'SENT') {
      return { ok: false, error: 'Vollmacht ist nicht mehr aktiv.' };
    }
    const snapshot = readPoaSigningSnapshot(poa.signingContentSnapshot, poa.signingContentSha256);
    if (!snapshot || isPoaExpired(snapshot.validUntil)) {
      return { ok: false, error: 'Vollmacht ist abgelaufen oder der Versandnachweis fehlt.' };
    }
    if ((snapshot.document?.versionId ?? null) !== poa.signingDocumentVersionId) {
      return { ok: false, error: 'Der Versandnachweis ist ungültig.' };
    }
    const documentVersion = snapshot.document
      ? await owner.documentVersion.findFirst({
          where: {
            id: snapshot.document.versionId,
            documentId: snapshot.document.documentId,
          },
          select: { id: true, documentId: true, sha256: true },
        })
      : null;
    if (!snapshotDocumentMatches(snapshot, documentVersion)) {
      return { ok: false, error: 'Das versendete Dokument ist nicht mehr nachweisbar.' };
    }

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const otpHash = hashToken(otp);
    const otpExpires = new Date(Date.now() + SIGNING_OTP_TTL_MINUTES * 60 * 1000);

    await owner.powerOfAttorney.update({
      where: { id: poa.id },
      data: {
        signingOtpHash: otpHash,
        signingOtpExpiresAt: otpExpires,
        // UX-Fix (Niedrig): Bei Reissue eines OTP signingOtpAttempts auf 0.
        // Vorher saß ein User mit 4 falschen Eingaben nach einem neuen Code-
        // Request immer noch auf 4/5 — ein weiterer Tipper-Fehler hätte den
        // Token komplett invalidiert. Das pro-Token-Hard-Cap (N-5,
        // poa-otp-cap, 10 Issues / 72 h) bleibt davon unberührt — ebenso
        // signingOtpAttemptsTotal (Audit 2026-06 Befund 2): der überlebt
        // Re-Issues und deckelt die Fehlversuche über den ganzen
        // Token-Lebenszyklus.
        signingOtpAttempts: 0,
      },
    });

    await sendTemplateMail({
      tenantId: poa.tenantId,
      slug: 'poa-otp',
      to: snapshot.signerEmail,
      vars: {
        contact: { fullName: snapshot.signerName, email: snapshot.signerEmail },
        subject: snapshot.subject,
        otp,
        expiresMinutes: SIGNING_OTP_TTL_MINUTES,
      },
      fallback: {
        subject: 'Bestätigungscode zur Vollmachts-Signatur',
        bodyMd:
          'Sehr geehrte/r {{contact.fullName}},\n\nIhr Bestätigungscode zur Signatur der Vollmacht „{{subject}}":\n\n**{{otp}}**\n\nDer Code ist {{expiresMinutes}} Minuten gültig.',
      },
    });

    return { ok: true };
  } finally {
    // Singleton: kein $disconnect — Connection wird wiederverwendet.
  }
}

/**
 * Schritt 3: OTP eingeben → Vollmacht signieren.
 * Erfordert Token + OTP + Bestätigungs-Häkchen.
 */
export async function signPoaAction(input: {
  rawToken: string;
  otp: string;
  consentAccepted: boolean;
}): Promise<ActionResult> {
  const parsedInput = z
    .object({
      rawToken: z.string().min(1).max(500),
      otp: z.string().regex(/^\d{6}$/),
      consentAccepted: z.literal(true),
    })
    .safeParse(input);
  if (!parsedInput.success) {
    return {
      ok: false,
      error: input.consentAccepted
        ? 'Token und ein sechsstelliger Bestätigungscode sind erforderlich.'
        : 'Bitte bestätigen Sie den Vollmachtsinhalt ausdrücklich.',
    };
  }
  const { rawToken, otp } = parsedInput.data;

  // N1: IP und User-Agent für die technische Signatur-Beweisspur
  // müssen serverseitig erhoben werden. Vorher wurden sie vom Client geliefert
  // (manipulierbar). signedByIp + signedByUserAgent gehen ins audit_log und
  // werden im Staff-UI als forensisches Indiz gerendert.
  const h = await headers();
  const ip = getClientIp(h);
  const userAgent = h.get('user-agent')?.slice(0, 500) ?? null;

  // N-5: Per-IP-Rate-Limit auf den Sign-Pfad selbst. Das pro-OTP-Limit von 5
  // Fehlversuchen + N-5 Hard-Cap der OTP-Issues machen Brute-Force schon teuer,
  // aber ohne IP-Bremse könnte ein Angreifer mit Tausenden Versuchen pro Minute
  // an die Schwelle rennen. 20 Versuche / 10 min ist mehr als jeder legitime
  // Nutzer braucht.
  const ipLimit = await checkIpOrGlobalLimit(
    'poa-sign',
    ip,
    { max: 20, windowSec: 600 },
    { max: 200, windowSec: 600 },
  );
  if (!ipLimit.ok) {
    return {
      ok: false,
      error: `Zu viele Versuche. Bitte ${Math.ceil(ipLimit.retryAfter / 60)} Min. warten.`,
    };
  }

  const tokenHash = hashToken(rawToken);
  const otpHash = hashToken(otp);

  const MAX_POA_OTP_ATTEMPTS = 5;
  // Audit 2026-06 Befund 2: Cap über den GESAMTEN Token-Lebenszyklus. Der
  // pro-OTP-Zähler wird beim Re-Issue zurückgesetzt (UX) — mit Issue-Cap 10
  // ergäbe das allein ~50 Versuche. Der Total-Zähler überlebt Re-Issues:
  // nach 15 Fehlversuchen ist der Signatur-Token endgültig hinüber, egal
  // wie viele frische OTPs angefordert wurden.
  const MAX_POA_OTP_ATTEMPTS_TOTAL = 15;

  // Generische Fehlermeldung (N5): kein Information-Disclosure über den
  // Token-Lebenszyklus oder den Snapshot-Zustand.
  const GENERIC_ERROR = 'Link oder Code ungültig. Bitte fordern Sie einen neuen Signaturcode an.';
  const lookup = await prismaOwner.powerOfAttorney.findFirst({
    where: { signingTokenHash: tokenHash },
    select: { id: true, tenantId: true, signerContactId: true },
  });
  if (!lookup) return { ok: false, error: GENERIC_ERROR };

  try {
    return await withTenantContext(
      {
        tenantId: lookup.tenantId,
        actorId: lookup.signerContactId,
        actorType: lookup.signerContactId ? 'CLIENT_CONTACT' : 'SYSTEM',
      },
      async (tx) => {
        const poa = await tx.powerOfAttorney.findFirst({
          where: { id: lookup.id, signingTokenHash: tokenHash },
        });
        if (!poa || poa.status !== 'SENT') return { ok: false, error: GENERIC_ERROR };
        if (!poa.signingTokenExpiresAt || poa.signingTokenExpiresAt < new Date()) {
          return { ok: false, error: GENERIC_ERROR };
        }
        if (!poa.signingOtpExpiresAt || poa.signingOtpExpiresAt < new Date()) {
          return { ok: false, error: GENERIC_ERROR };
        }

        const snapshot = readPoaSigningSnapshot(
          poa.signingContentSnapshot,
          poa.signingContentSha256,
        );
        if (!snapshot || isPoaExpired(snapshot.validUntil)) {
          return { ok: false, error: GENERIC_ERROR };
        }
        if ((snapshot.document?.versionId ?? null) !== poa.signingDocumentVersionId) {
          return { ok: false, error: GENERIC_ERROR };
        }
        const documentVersion = snapshot.document
          ? await tx.documentVersion.findFirst({
              where: {
                id: snapshot.document.versionId,
                documentId: snapshot.document.documentId,
              },
              select: { id: true, documentId: true, sha256: true },
            })
          : null;
        if (!snapshotDocumentMatches(snapshot, documentVersion)) {
          return { ok: false, error: GENERIC_ERROR };
        }

        const otpMatches =
          !!poa.signingOtpHash &&
          poa.signingOtpHash.length === otpHash.length &&
          timingSafeEqual(Buffer.from(poa.signingOtpHash, 'hex'), Buffer.from(otpHash, 'hex'));
        if (!otpMatches) {
          const updated = await tx.powerOfAttorney.update({
            where: { id: poa.id },
            data: {
              signingOtpAttempts: { increment: 1 },
              signingOtpAttemptsTotal: { increment: 1 },
            },
            select: { signingOtpAttempts: true, signingOtpAttemptsTotal: true },
          });
          if (
            updated.signingOtpAttempts >= MAX_POA_OTP_ATTEMPTS ||
            updated.signingOtpAttemptsTotal >= MAX_POA_OTP_ATTEMPTS_TOTAL
          ) {
            await tx.powerOfAttorney.update({
              where: { id: poa.id },
              data: {
                signingTokenHash: null,
                signingOtpHash: null,
                signingOtpAttempts: 0,
                signingOtpAttemptsTotal: 0,
              },
            });
          }
          return { ok: false, error: GENERIC_ERROR };
        }

        const signedAt = new Date();
        const contentSha256 = Buffer.from(poa.signingContentSha256!);
        const claim = await tx.powerOfAttorney.updateMany({
          where: { id: poa.id, status: 'SENT', signingTokenHash: tokenHash },
          data: {
            status: 'SIGNED',
            signedAt,
            signedByIp: ip,
            signedByUserAgent: userAgent,
            signedContentSha256: prismaBytes(contentSha256),
            signedDocumentVersionId: poa.signingDocumentVersionId,
            signingTokenHash: null,
            signingOtpHash: null,
            signingOtpAttempts: 0,
            signingOtpAttemptsTotal: 0,
          },
        });
        if (claim.count !== 1) return { ok: false, error: GENERIC_ERROR };

        // Statuswechsel und Evidence-Record liegen absichtlich in derselben
        // Tenant-Transaktion. Schlägt die Beweisspur fehl, wird SIGNED zurückgerollt.
        await evidenceService.record(tx, {
          tenantId: poa.tenantId,
          actorType: poa.signerContactId ? 'CLIENT_CONTACT' : 'SYSTEM',
          actorId: poa.signerContactId,
          action: 'poa.sign',
          resourceType: 'power_of_attorney',
          resourceId: poa.id,
          after: {
            signerEmail: snapshot.signerEmail,
            signerName: snapshot.signerName,
            signedAt: signedAt.toISOString(),
            explicitContentConsent: true,
            signedContentSha256: contentSha256.toString('hex'),
            signedDocumentVersionId: poa.signingDocumentVersionId,
            signedDocumentSha256: snapshot.document?.sha256 ?? null,
            snapshotSchemaVersion: snapshot.schemaVersion,
            ip,
            userAgent,
          },
          ip,
          userAgent,
        });
        await notify(tx, {
          tenantId: poa.tenantId,
          staffId: poa.createdByStaff,
          kind: 'POA_SIGNED',
          title: `Vollmacht „${snapshot.subject}" wurde unterschrieben`,
          body: `${snapshot.signerName} (${snapshot.signerEmail}) hat soeben unterzeichnet.`,
          href: `/staff/poa/${poa.id}`,
          resourceType: 'power_of_attorney',
          resourceId: poa.id,
        });

        return { ok: true };
      },
    );
  } catch {
    return {
      ok: false,
      error: 'Die Signatur konnte nicht sicher abgeschlossen werden. Bitte erneut versuchen.',
    };
  }
}
