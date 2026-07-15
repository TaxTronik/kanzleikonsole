// =============================================================================
// GwG-Onboarding-Service
//
// Token-basierter Mandanten-Wizard ohne Portal-Account. Nutzt einen Owner-
// Prisma-Client (BYPASSRLS), weil der Mandant zum Zeitpunkt der Einladung
// keinen Auth-Kontext hat. Tenant- und Client-Zuordnung kommt vom Token.
//
// Sicherheits-Modell:
//   - Token (32 Byte random) wird in plain per Mail an den Mandanten verschickt
//   - Hash (SHA-256) wird in `gwg_onboarding_invite.token_hash` gespeichert
//   - Lookup ausschließlich über den Hash
//   - Ablauf: 14 Tage Default
//   - Submit setzt status='SUBMITTED' und schreibt IP+UserAgent als Audit-Trail
// =============================================================================

import { createHash, randomBytes } from 'node:crypto';
import { type Client, type Tenant } from '@prisma/client';
import { prismaOwner } from '@/server/db/prisma-owner';

export const INVITE_TTL_DAYS = 14;

export function generateInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export function hashInviteToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Markiert eine Einladung nur dann als abgelaufen, wenn sie beim Write noch
 * offen und zum selben Lookup-Zeitpunkt faellig ist. Der statusgebundene CAS
 * verhindert, dass ein wartender Ablauf-Write einen parallel bereits
 * geclaimten SUBMITTED- oder CANCELLED-Status ueberschreibt.
 */
export async function expireOpenInviteIfDue(inviteId: string, now: Date): Promise<boolean> {
  const expired = await prismaOwner.gwgOnboardingInvite.updateMany({
    where: {
      id: inviteId,
      status: { in: ['PENDING', 'STARTED'] },
      expiresAt: { lte: now },
    },
    data: { status: 'EXPIRED' },
  });
  return expired.count === 1;
}

export interface LoadedInvite {
  inviteId: string;
  inviteName: string;
  inviteEmail: string;
  status: 'PENDING' | 'STARTED' | 'SUBMITTED' | 'EXPIRED' | 'CANCELLED';
  expiresAt: Date;
  client: Pick<
    Client,
    'id' | 'name' | 'kind' | 'street' | 'postalCode' | 'city' | 'countryIso' | 'vatId'
  >;
  tenant: Pick<Tenant, 'id' | 'name' | 'slug'>;
}

// S-5: Einheitliche Fehlermeldung für alle „Token nicht nutzbar"-Zustände
// (nicht gefunden / cancelled / submitted / expired). Vorher konnten vier
// unterscheidbare Texte den Token-Lifecycle gegenüber einem Angreifer mit
// abgegriffenem Token (Mail-Log, Browser-History) leaken. Symmetrisch zum
// PoA-GENERIC_TOKEN_ERROR-Pattern. Exportiert, damit auch der Rate-Limit-
// Pfad der Page dieselbe Ansicht rendert (kein Token-Probing-Orakel).
export const GENERIC_TOKEN_ERROR = 'Einladung ungültig oder nicht mehr verfügbar.';

export async function loadInviteByRawToken(
  rawToken: string,
): Promise<{ ok: true; invite: LoadedInvite } | { ok: false; error: string }> {
  if (!rawToken || rawToken.length < 10) {
    return { ok: false, error: GENERIC_TOKEN_ERROR };
  }
  const tokenHash = hashInviteToken(rawToken);
  const inv = await prismaOwner.gwgOnboardingInvite.findFirst({
    where: { tokenHash },
    include: {
      client: {
        select: {
          id: true,
          name: true,
          kind: true,
          street: true,
          postalCode: true,
          city: true,
          countryIso: true,
          vatId: true,
        },
      },
      tenant: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!inv) {
    return { ok: false, error: GENERIC_TOKEN_ERROR };
  }
  if (inv.status === 'CANCELLED' || inv.status === 'SUBMITTED' || inv.status === 'EXPIRED') {
    return { ok: false, error: GENERIC_TOKEN_ERROR };
  }
  const now = new Date();
  if (inv.expiresAt.getTime() <= now.getTime()) {
    await expireOpenInviteIfDue(inv.id, now);
    return { ok: false, error: GENERIC_TOKEN_ERROR };
  }

  // Beim ersten Öffnen Status auf STARTED
  let effectiveStatus = inv.status;
  if (inv.status === 'PENDING') {
    const started = await prismaOwner.gwgOnboardingInvite.updateMany({
      where: {
        id: inv.id,
        tokenHash,
        status: 'PENDING',
        expiresAt: { gt: now },
      },
      data: { status: 'STARTED' },
    });
    if (started.count === 0) {
      // Ein paralleles Öffnen darf weiterarbeiten; eine zwischenzeitliche
      // Supersession/Cancellation hingegen darf niemals auf STARTED
      // zurückgeschrieben und damit wiederbelebt werden.
      const concurrentlyStarted = await prismaOwner.gwgOnboardingInvite.findFirst({
        where: {
          id: inv.id,
          tokenHash,
          status: 'STARTED',
          expiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (!concurrentlyStarted) {
        return { ok: false, error: GENERIC_TOKEN_ERROR };
      }
    }
    effectiveStatus = 'STARTED';
  }

  return {
    ok: true,
    invite: {
      inviteId: inv.id,
      inviteName: inv.inviteName,
      inviteEmail: inv.inviteEmail,
      status: effectiveStatus,
      expiresAt: inv.expiresAt,
      client: inv.client,
      tenant: inv.tenant,
    },
  };
}

export { prismaOwner };
