import type { TxClient } from '@taxtronik/db';
import { claimGwgOnboardingSubmitTx, lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';
import { resolveCurrentGwgInviteRevisionTx } from './bound-review';

const OPEN_INVITE_STATUSES = ['PENDING', 'STARTED'] as const;

/**
 * Revalidiert einen offenen Link unter dem Mandanten-Lifecycle-Lock und sperrt
 * danach seine Zeile. Die Lock-Reihenfolge (Advisory vor FOR UPDATE) entspricht
 * Submit/Review und verhindert Deadlocks. Stale Revisionen werden atomar
 * entwertet, bevor Seite oder Upload weiterarbeiten dürfen.
 */
export async function revalidateOpenGwgInviteRevisionTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    inviteId: string;
    tokenHash: string;
    now: Date;
  },
): Promise<boolean> {
  await lockGwgCheckLifecycleTx(tx, input);
  const openRows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM gwg_onboarding_invite
    WHERE id = ${input.inviteId}::uuid
      AND tenant_id = ${input.tenantId}::uuid
      AND client_id = ${input.clientId}::uuid
      AND token_hash = ${input.tokenHash}
      AND status IN ('PENDING'::gwg_invite_status, 'STARTED'::gwg_invite_status)
      AND expires_at > ${input.now}
    FOR UPDATE
  `;
  if (openRows.length !== 1) return false;

  const current = await resolveCurrentGwgInviteRevisionTx(tx, input);
  if (current) return true;

  await tx.gwgOnboardingInvite.updateMany({
    where: {
      id: input.inviteId,
      tokenHash: input.tokenHash,
      status: { in: [...OPEN_INVITE_STATUSES] },
    },
    data: {
      status: 'CANCELLED',
      cancelledAt: input.now,
      cancelledByStaff: null,
      tokenHash: '',
    },
  });
  return false;
}

export async function cancelOpenGwgInvitesTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    cancelledByStaff: string | null;
    exceptInviteId?: string;
  },
): Promise<number> {
  const cancelledAt = new Date();
  const cancelled = await tx.gwgOnboardingInvite.updateMany({
    where: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      ...(input.exceptInviteId ? { id: { not: input.exceptInviteId } } : {}),
      status: { in: [...OPEN_INVITE_STATUSES] },
    },
    data: {
      status: 'CANCELLED',
      cancelledAt,
      cancelledByStaff: input.cancelledByStaff,
      tokenHash: '',
    },
  });
  return cancelled.count;
}

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
      reason: 'INVALID' | 'STALE' | 'SUPERSEDED';
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
  const currentRevision = await resolveCurrentGwgInviteRevisionTx(tx, input);
  if (!currentRevision) {
    // Kein Throw in dieser Transaktion: Die Entwertung des fachlich veralteten
    // Links muss committen. Der Aufrufer übersetzt den Sentinel erst nach dem
    // erfolgreichen Transaktionsende in eine anonyme Fehlermeldung.
    await tx.gwgOnboardingInvite.updateMany({
      where: {
        id: input.inviteId,
        tokenHash: input.tokenHash,
        status: { in: [...OPEN_INVITE_STATUSES] },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: submittedAt,
        cancelledByStaff: null,
        tokenHash: '',
      },
    });
    return { ok: false, reason: 'STALE' };
  }

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
