import type { TxClient } from '@taxtronik/db';
import { lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';
import {
  gwgInviteClientBaselineHash,
  gwgInviteDraftRevisionHash,
  loadGwgInviteClientBaselineTx,
  loadLatestGwgInviteDraftTx,
} from './invite-draft-revision';

export type GwgInviteBindingResult =
  | {
      ok: true;
      gwgCheckId: string | null;
      boundCheckRevision: string | null;
      boundClientRevision: string | null;
    }
  | { ok: false; error: string };

/**
 * Gemeinsamer Ausstellvertrag für direkte und Onboarding-Wizard-Einladungen.
 * Ungebunden ist nur die echte Ersteinladung ohne jeglichen Check. Ein DRAFT
 * wird kryptografisch gebunden; andere Zustände verlangen einen neuen Zyklus.
 */
export async function prepareGwgInviteBindingTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    requestedCheckId?: string;
    bindLatestDraft: boolean;
  },
): Promise<GwgInviteBindingResult> {
  await lockGwgCheckLifecycleTx(tx, input);
  const latestCheck = await loadLatestGwgInviteDraftTx(tx, input);

  if (!latestCheck) {
    if (input.requestedCheckId) {
      return {
        ok: false,
        error: 'Der vorbereitete GwG-Entwurf existiert nicht mehr. Bitte Seite neu laden.',
      };
    }
    const client = await loadGwgInviteClientBaselineTx(tx, input);
    return client
      ? {
          ok: true,
          gwgCheckId: null,
          boundCheckRevision: null,
          boundClientRevision: gwgInviteClientBaselineHash(client),
        }
      : { ok: false, error: 'Mandant nicht gefunden. Bitte Seite neu laden.' };
  }

  if (!input.requestedCheckId && !input.bindLatestDraft) {
    return {
      ok: false,
      error:
        'Eine ungebundene Einladung ist nur vor der ersten GwG-Prüfung zulässig. Bitte zuerst einen neuen Prüfzyklus starten.',
    };
  }
  if (
    (input.requestedCheckId && latestCheck.id !== input.requestedCheckId) ||
    latestCheck.status !== 'DRAFT' ||
    latestCheck.verifiedAt !== null ||
    latestCheck.destroyedAt !== null
  ) {
    return {
      ok: false,
      error:
        'Es gibt keinen aktuellen bearbeitbaren GwG-Entwurf. Bitte zuerst einen neuen Prüfzyklus starten.',
    };
  }

  return {
    ok: true,
    gwgCheckId: latestCheck.id,
    boundCheckRevision: gwgInviteDraftRevisionHash(latestCheck),
    boundClientRevision: null,
  };
}
