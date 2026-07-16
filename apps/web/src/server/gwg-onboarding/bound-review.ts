import type { TxClient } from '@taxtronik/db';
import {
  gwgInviteClientBaselineHash,
  gwgInviteDraftRevisionHash,
  loadGwgInviteClientBaselineTx,
  loadLatestGwgInviteDraftTx,
} from './invite-draft-revision';

export async function resolveCurrentGwgInviteRevisionTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    inviteId: string;
  },
): Promise<{ gwgCheckId: string | null } | null> {
  const currentInvite = await tx.gwgOnboardingInvite.findUnique({
    where: { id: input.inviteId },
    select: {
      gwgCheckId: true,
      boundCheckRevision: true,
      boundClientRevision: true,
    },
  });
  if (!currentInvite) return null;

  const latestCheck = await loadLatestGwgInviteDraftTx(tx, input);
  if (currentInvite.gwgCheckId === null) {
    if (
      latestCheck ||
      currentInvite.boundCheckRevision !== null ||
      !currentInvite.boundClientRevision
    ) {
      return null;
    }
    const client = await loadGwgInviteClientBaselineTx(tx, input);
    return client && gwgInviteClientBaselineHash(client) === currentInvite.boundClientRevision
      ? { gwgCheckId: null }
      : null;
  }

  if (
    currentInvite.boundClientRevision !== null ||
    !currentInvite.boundCheckRevision ||
    !latestCheck ||
    latestCheck.id !== currentInvite.gwgCheckId ||
    latestCheck.status !== 'DRAFT' ||
    latestCheck.verifiedAt !== null ||
    latestCheck.destroyedAt !== null ||
    gwgInviteDraftRevisionHash(latestCheck) !== currentInvite.boundCheckRevision
  ) {
    return null;
  }
  return { gwgCheckId: latestCheck.id };
}

/**
 * Prüft unter dem bereits gehaltenen Mandanten-Lifecycle-Lock, ob eine bei
 * Ausgabe echte ungebundene Ersteinladung weiterhin die erste Prüfung startet.
 * Sobald Staff inzwischen einen Check angelegt hat, darf der Portal-Submit
 * keinerlei Daten überschreiben.
 */
export async function canStartUnboundGwgInviteTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string; inviteId: string },
): Promise<boolean> {
  const resolved = await resolveCurrentGwgInviteRevisionTx(tx, input);
  return resolved?.gwgCheckId === null;
}

/**
 * Löst ausschließlich den bei Einladungsausgabe gebundenen, unveränderten
 * neuesten DRAFT auf. Der Vergleich findet unter dem bereits gehaltenen
 * Mandanten-Lifecycle-Lock statt und ist absichtlich read-only: Erst nach
 * erfolgreicher CAS-Prüfung darf der Portal-Submit Personenlisten ersetzen.
 */
export async function resolveBoundGwgInviteDraftTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    inviteId: string;
    expectedCheckId: string;
  },
): Promise<{ id: string } | null> {
  const resolved = await resolveCurrentGwgInviteRevisionTx(tx, input);
  return resolved?.gwgCheckId === input.expectedCheckId ? { id: input.expectedCheckId } : null;
}
