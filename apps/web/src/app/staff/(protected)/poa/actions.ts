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
import { checkRateLimit, checkIpOrGlobalLimit, getClientIp } from '@/server/rate-limit';
import { isStaffAdmin, toActionError } from '@/server/auth/rbac';
import { headers } from 'next/headers';
import { staffActionGuard, withStaff, ActionError } from '@/server/actions/staff-action';

const SIGNING_TOKEN_TTL_HOURS = 72;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  signerContactId: z.string().uuid().optional().or(z.literal('')),
  signerEmail: z.string().email().max(255),
  signerName: z.string().min(1).max(200),
  subject: z.string().min(1).max(300),
  scope: z.string().min(1).max(20000),
  validFrom: z.string().date(),
  validUntil: z.string().date().optional().or(z.literal('')),
});

export interface ActionResult { ok: boolean; error?: string; }

export async function createPoaAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) return; // void: still abbrechen (Seite ist ohnehin auth-gated)
  const { tenantId, staffId, ctx, session } = g;

  // R-4: Vollmachtserteilung ist berufsrechtlich eine Erklärung des
  // Steuerberaters (§§ 3 ff. StBerG) — der Berufsträger trägt die Haftung.
  // Ein Sachbearbeiter ohne Bestellung darf das technisch nicht auslösen
  // können. ADMIN/PARTNER (in der Praxis: Kanzleileitung + Partner =
  // Berufsträger) als Gate. Für 4-Augen-Workflow später separater Schritt.
  if (!isStaffAdmin(session)) {
    throw new ActionError('Vollmachten dürfen nur von ADMIN/PARTNER (Berufsträger) angelegt werden.');
  }

  const parsed = CreateSchema.safeParse({
    clientId: formData.get('clientId'),
    signerContactId: formData.get('signerContactId') ?? '',
    signerEmail: formData.get('signerEmail'),
    signerName: formData.get('signerName'),
    subject: formData.get('subject'),
    scope: formData.get('scope'),
    validFrom: formData.get('validFrom'),
    validUntil: formData.get('validUntil') ?? '',
  });
  if (!parsed.success) throw new ActionError('Validierungsfehler.');

  const data = parsed.data;

  const id = await withTenantContext(ctx, async (tx) => {
      const poa = await tx.powerOfAttorney.create({
        data: {
          tenantId,
          clientId: data.clientId,
          signerContactId: data.signerContactId || null,
          signerEmail: data.signerEmail.toLowerCase(),
          signerName: data.signerName,
          subject: data.subject,
          scope: data.scope,
          validFrom: new Date(data.validFrom),
          validUntil: data.validUntil ? new Date(data.validUntil) : null,
          status: 'DRAFT',
          createdByStaff: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'poa.create',
        resourceType: 'power_of_attorney',
        resourceId: poa.id,
        after: { subject: data.subject, signerEmail: data.signerEmail },
      });
      return poa.id;
    },
  );

  revalidatePath('/staff/poa');
  redirect(`/staff/poa/${id}`);
}

const SendSchema = z.object({ poaId: z.string().uuid() });

export async function sendForSignatureAction(formData: FormData): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = SendSchema.safeParse({ poaId: formData.get('poaId') });
  if (!parsed.success) return { ok: false, error: 'Ungültig.' };

  const { poaId } = parsed.data;

  // Token im Klartext, Hash in DB
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SIGNING_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  let sent: { poa: Awaited<ReturnType<typeof prismaOwner.powerOfAttorney.update>>; tenantName: string };
  try {
    sent = await withTenantContext(ctx, async (tx) => {
      const before = await tx.powerOfAttorney.findUnique({ where: { id: poaId } });
      if (!before) throw new ActionError('Vollmacht nicht gefunden.');
      if (before.status === 'SIGNED') throw new ActionError('Bereits unterschrieben.');

      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new ActionError('Mandant fehlt.');

      const updated = await tx.powerOfAttorney.update({
        where: { id: poaId },
        data: {
          status: 'SENT',
          signingTokenHash: tokenHash,
          signingTokenExpiresAt: expiresAt,
          // Etwaiges OTP zurücksetzen
          signingOtpHash: null,
          signingOtpExpiresAt: null,
        },
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'poa.send',
        resourceType: 'power_of_attorney',
        resourceId: poaId,
        after: { signerEmail: before.signerEmail },
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
      bodyMd: 'Sehr geehrte/r {{contact.fullName}},\n\nbitte signieren Sie die anliegende Vollmacht über folgenden Link:\n\n{{link}}\n\nDer Link ist {{expiresHours}} Stunden gültig.',
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
    async (tx, { tenantId, staffId }) => {
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
      };
      tenantName: string;
    }
  | { ok: false; error: string }
> {
  if (!rawToken) return { ok: false, error: 'Kein Token in der URL.' };
  const tokenHash = hashToken(rawToken);

  const owner = prismaOwner;
  // Anti-Enumeration (N5): einheitliche Fehlermeldung über alle
  // Lebenszyklus-Phasen hinweg. Token-Hashes sind 32 Byte, Brute-Force
  // praktisch ausgeschlossen — aber Defense in Depth gegen
  // Information-Disclosure.
  const GENERIC_TOKEN_ERROR = 'Link ungültig oder abgelaufen. Bitte fordern Sie einen neuen Link an.';

  try {
    const poa = await owner.powerOfAttorney.findFirst({
      where: { signingTokenHash: tokenHash },
    });
    if (!poa) return { ok: false, error: GENERIC_TOKEN_ERROR };
    if (!poa.signingTokenExpiresAt || poa.signingTokenExpiresAt < new Date()) {
      return { ok: false, error: GENERIC_TOKEN_ERROR };
    }
    if (poa.status === 'REVOKED' || poa.status === 'EXPIRED' || poa.status === 'SIGNED') {
      return { ok: false, error: GENERIC_TOKEN_ERROR };
    }
    const tenant = await owner.tenant.findUnique({ where: { id: poa.tenantId } });
    return {
      ok: true,
      poa: {
        id: poa.id,
        subject: poa.subject,
        scope: poa.scope,
        signerName: poa.signerName,
        signerEmail: poa.signerEmail,
        validFrom: poa.validFrom,
        validUntil: poa.validUntil,
        status: poa.status,
      },
      tenantName: tenant?.name ?? 'Ihre Kanzlei',
    };
  } finally {
    // Singleton: kein $disconnect — Connection wird wiederverwendet.
  }
}

const SIGNING_OTP_TTL_MINUTES = 10;

/**
 * Schritt 2: Anfordern eines OTPs (zweiter Faktor) für die Signatur.
 * Sendet einen 6-stelligen Code per Mail an die hinterlegte Adresse.
 */
export async function requestSigningOtpAction(rawToken: string): Promise<ActionResult> {
  if (!rawToken) return { ok: false, error: 'Kein Token.' };
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
      error: 'OTP-Limit für diesen Link erreicht. Bitte beim Steuerberater eine neue Signatur-Einladung anfordern.',
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
        // poa-otp-cap, 10 Issues / 72 h) bleibt davon unberührt.
        signingOtpAttempts: 0,
      },
    });

    await sendTemplateMail({
      tenantId: poa.tenantId,
      slug: 'poa-otp',
      to: poa.signerEmail,
      vars: {
        contact: { fullName: poa.signerName, email: poa.signerEmail },
        subject: poa.subject,
        otp,
        expiresMinutes: SIGNING_OTP_TTL_MINUTES,
      },
      fallback: {
        subject: 'Bestätigungscode zur Vollmachts-Signatur',
        bodyMd: 'Sehr geehrte/r {{contact.fullName}},\n\nIhr Bestätigungscode zur Signatur der Vollmacht „{{subject}}":\n\n**{{otp}}**\n\nDer Code ist {{expiresMinutes}} Minuten gültig.',
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
}): Promise<ActionResult> {
  const { rawToken, otp } = input;
  if (!rawToken || !otp) return { ok: false, error: 'Token und OTP erforderlich.' };

  // N1: eIDAS-Compliance — IP und User-Agent für die Signatur-Beweisspur
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

  const owner = prismaOwner;
  const MAX_POA_OTP_ATTEMPTS = 5;

  try {
    const poa = await owner.powerOfAttorney.findFirst({ where: { signingTokenHash: tokenHash } });
    // Generische Fehlermeldung (N5): kein Information-Disclosure über
    // Token-Lebenszyklus (existiert nicht / abgelaufen / revoked / bereits
    // signiert / OTP falsch sind alle "ungültig").
    const GENERIC_ERROR = 'Link oder Code ungültig. Bitte fordern Sie einen neuen Signaturcode an.';
    if (!poa) return { ok: false, error: GENERIC_ERROR };
    if (poa.status !== 'SENT') return { ok: false, error: GENERIC_ERROR };
    if (!poa.signingTokenExpiresAt || poa.signingTokenExpiresAt < new Date()) {
      return { ok: false, error: GENERIC_ERROR };
    }
    if (!poa.signingOtpExpiresAt || poa.signingOtpExpiresAt < new Date()) {
      return { ok: false, error: GENERIC_ERROR };
    }

    // Falsche OTP → Zähler hochzählen (N1). Bei Erreichen des Limits Token +
    // OTP entwerten — neue Signatur-Anforderung über Staff-UI nötig.
    // N2: timingSafeEqual — beide Hex-Strings sind exakt 64 Zeichen
    // (SHA-256), `===` würde character-by-character vergleichen und per
    // Timing leaken. Praktisch durch 5-Versuch-Limit gedeckelt, aber konsistent
    // zur n8n-Signature-Verifikation.
    const otpMatches =
      !!poa.signingOtpHash &&
      poa.signingOtpHash.length === otpHash.length &&
      timingSafeEqual(Buffer.from(poa.signingOtpHash, 'hex'), Buffer.from(otpHash, 'hex'));
    if (!otpMatches) {
      const updated = await owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: { signingOtpAttempts: { increment: 1 } },
        select: { signingOtpAttempts: true },
      });
      if (updated.signingOtpAttempts >= MAX_POA_OTP_ATTEMPTS) {
        await owner.powerOfAttorney.update({
          where: { id: poa.id },
          data: {
            signingTokenHash: null,
            signingOtpHash: null,
            signingOtpAttempts: 0,
          },
        });
      }
      return { ok: false, error: GENERIC_ERROR };
    }

    // Atomar als signiert markieren (nur ein Versuch erfolgreich)
    const claim = await owner.powerOfAttorney.updateMany({
      where: { id: poa.id, status: 'SENT' },
      data: {
        status: 'SIGNED',
        signedAt: new Date(),
        signedByIp: ip,
        signedByUserAgent: userAgent,
        // Token + OTP entwerten + Counter zurücksetzen
        signingTokenHash: null,
        signingOtpHash: null,
        signingOtpAttempts: 0,
      },
    });
    if (claim.count !== 1) {
      return { ok: false, error: GENERIC_ERROR };
    }

    // Audit-Eintrag + Notification im Tenant-Kontext
    const { withTenantContext } = await import('@taxtronik/db');
    const { notify } = await import('@/server/notifications/service');
    await withTenantContext(
      { tenantId: poa.tenantId, actorId: poa.signerContactId, actorType: poa.signerContactId ? 'CLIENT_CONTACT' : 'SYSTEM' },
      async (tx) => {
        await evidenceService.record(tx, {
          tenantId: poa.tenantId,
          actorType: poa.signerContactId ? 'CLIENT_CONTACT' : 'SYSTEM',
          actorId: poa.signerContactId,
          action: 'poa.sign',
          resourceType: 'power_of_attorney',
          resourceId: poa.id,
          after: {
            signerEmail: poa.signerEmail,
            signerName: poa.signerName,
            signedAt: new Date().toISOString(),
            ip,
            userAgent,
          },
          ip,
          userAgent,
        });
        // Benachrichtige den Staff, der die Vollmacht erstellt hat
        await notify(tx, {
          tenantId: poa.tenantId,
          staffId: poa.createdByStaff,
          kind: 'POA_SIGNED',
          title: `Vollmacht „${poa.subject}" wurde unterschrieben`,
          body: `${poa.signerName} (${poa.signerEmail}) hat soeben unterzeichnet.`,
          href: `/staff/poa/${poa.id}`,
          resourceType: 'power_of_attorney',
          resourceId: poa.id,
        });
      },
    );

    return { ok: true };
  } finally {
    // Singleton: kein $disconnect — Connection wird wiederverwendet.
  }
}
