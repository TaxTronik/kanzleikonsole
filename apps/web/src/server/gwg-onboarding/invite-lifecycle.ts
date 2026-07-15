import type { TxClient } from '@taxtronik/db';
import { claimGwgOnboardingSubmitTx, lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';

const OPEN_INVITE_STATUSES = ['PENDING', 'STARTED'] as const;

export interface PrepareGwgInviteIssueResult {
  createdAt: Date;
  supersededInviteCount: number;
}

/**
 * Serialisiert die Ausstellung einer neuen Einladung mit allen Submit-Pfaden.
 * Eine neue Einladung ersetzt offene Vorgänger dauerhaft; deren Token dürfen
 * nicht wieder aufleben, wenn sie bereits in einem Browser geöffnet waren.
 */
export async function prepareGwgInviteIssueTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    cancelledByStaff: string;
  },
): Promise<PrepareGwgInviteIssueResult> {
  await lockGwgCheckLifecycleTx(tx, input);

  const latest = await tx.gwgOnboardingInvite.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true },
  });
  // created_at hat Millisekundenpräzision. Unter dem Mandanten-Lock erzwingen
  // wir deshalb eine strikt monotone Ausgabezeit, auch bei Clock-Skew oder zwei
  // unmittelbar aufeinanderfolgenden Ausstellungen.
  const createdAt = new Date(
    Math.max(Date.now(), latest ? latest.createdAt.getTime() + 1 : Number.NEGATIVE_INFINITY),
  );
  const cancelledAt = new Date();
  const superseded = await tx.gwgOnboardingInvite.updateMany({
    where: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      status: { in: [...OPEN_INVITE_STATUSES] },
    },
    data: {
      status: 'CANCELLED',
      cancelledAt,
      cancelledByStaff: input.cancelledByStaff,
      tokenHash: '',
    },
  });

  return { createdAt, supersededInviteCount: superseded.count };
}

export type ClaimCurrentGwgInviteResult =
  | {
      ok: true;
      submittedAt: Date;
      supersededInviteCount: number;
    }
  | {
      ok: false;
      reason: 'INVALID' | 'SUPERSEDED';
    };

/**
 * Beansprucht ausschließlich die aktuellste Einladung eines Mandanten und
 * entwertet bei Erfolg alle anderen noch offenen Links in derselben Tx.
 */
export async function claimCurrentGwgInviteSubmitTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    inviteId: string;
    tokenHash: string;
    submittedIp: string | null;
    submittedUa: string | null;
  },
): Promise<ClaimCurrentGwgInviteResult> {
  await lockGwgCheckLifecycleTx(tx, input);

  const latest = await tx.gwgOnboardingInvite.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  if (!latest || latest.id !== input.inviteId) {
    return { ok: false, reason: 'SUPERSEDED' };
  }

  const submittedAt = new Date();
  const claimed = await claimGwgOnboardingSubmitTx(tx, {
    inviteId: input.inviteId,
    tokenHash: input.tokenHash,
    submittedAt,
    submittedIp: input.submittedIp,
    submittedUa: input.submittedUa,
  });
  if (!claimed) return { ok: false, reason: 'INVALID' };

  const superseded = await tx.gwgOnboardingInvite.updateMany({
    where: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      id: { not: input.inviteId },
      status: { in: [...OPEN_INVITE_STATUSES] },
    },
    data: {
      status: 'CANCELLED',
      cancelledAt: submittedAt,
      cancelledByStaff: null,
      tokenHash: '',
    },
  });

  return {
    ok: true,
    submittedAt,
    supersededInviteCount: superseded.count,
  };
}
