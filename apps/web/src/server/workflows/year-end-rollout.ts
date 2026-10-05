// =============================================================================
// Jahreswechsel-Rollout (YEAR-END-CAMPAIGN-001), P-19.
//
// Vorher: je Mandant Zugriffsprüfung, Freischalt-Read, Existenz-Read und vier
// Einzel-Writes (Submission, Request, Submission-Update, Eintrag) — bis zu
// 1.400 sequenzielle Statements für 200 Mandanten in einer Serializable-Tx.
// Jetzt: Freischaltung und vorhandene Zuordnungen vorab mit je EINER Abfrage,
// IDs im Prozess vergeben und Submissions, Requests und Einträge mit je EINEM
// createMany anlegen. Dieselben Zeilen, dieselben Fehler in derselben
// Reihenfolge, weiterhin atomar unter dem Kampagnenlock des Aufrufers.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { StaffCtx } from '@/server/actions/staff-action';
import { ActionError } from '@/server/actions/action-error';
import { assertClientAccessTx } from '@/server/auth/rbac';

/** YEAR-END-CAMPAIGN-001: ausdrückliche Auswahl von maximal 200 Mandaten je Lauf. */
export const YEAR_END_ROLLOUT_MAX_CLIENTS = 200;

export const YEAR_END_REQUEST_DESCRIPTION =
  'Bitte bearbeiten Sie die Jahreswechsel-Checkliste und laden Sie die angeforderten Unterlagen hoch. Ihre Kanzlei prüft die eingereichten Angaben anschließend.';

export interface RolloutCampaign {
  id: string;
  templateId: string;
  schemaSnapshot: Prisma.JsonValue;
  name: string;
  year: number;
  dueAt: Date;
}

/**
 * Legt je noch nicht zugeordnetem Mandanten Submission, Request und Eintrag an
 * und liefert deren Anzahl. Erwartet den Kampagnenlock des Aufrufers.
 */
export async function rolloutCampaignTx(
  tx: TxClient,
  g: Pick<StaffCtx, 'session' | 'tenantId' | 'staffId'>,
  campaign: RolloutCampaign,
  clientIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(clientIds)];
  const eligible = new Set(
    (
      await tx.client.findMany({
        where: { id: { in: ids }, allowActive: true, mandateEndedAt: null },
        select: { id: true },
      })
    ).map((client) => client.id),
  );
  // Prüfreihenfolge je Mandant wie bisher: erst Zugriff, dann Freischaltung.
  for (const clientId of ids) {
    await assertClientAccessTx(tx, g.session, clientId);
    if (!eligible.has(clientId)) throw new ActionError('Mandant ohne freigeschaltetes Portal.');
  }
  const assigned = new Set(
    (
      await tx.yearEndCampaignEntry.findMany({
        where: { campaignId: campaign.id, clientId: { in: ids } },
        select: { clientId: true },
      })
    ).map((entry) => entry.clientId),
  );
  const rows = ids
    .filter((clientId) => !assigned.has(clientId))
    .map((clientId) => ({ clientId, submissionId: randomUUID(), requestId: randomUUID() }));
  if (rows.length === 0) return 0;

  const title = `${campaign.name} ${campaign.year}`;
  // form_submission.request_id hat keinen Fremdschlüssel; die vorab vergebene
  // Request-ID ersetzt das frühere Insert-dann-Update je Mandant.
  await tx.formSubmission.createMany({
    data: rows.map((row) => ({
      id: row.submissionId,
      tenantId: g.tenantId,
      clientId: row.clientId,
      templateId: campaign.templateId,
      schemaSnapshot: campaign.schemaSnapshot as Prisma.InputJsonValue,
      name: title,
      createdByStaff: g.staffId,
      requestId: row.requestId,
    })),
  });
  await tx.request.createMany({
    data: rows.map((row) => ({
      id: row.requestId,
      tenantId: g.tenantId,
      clientId: row.clientId,
      title,
      description: YEAR_END_REQUEST_DESCRIPTION,
      formSubmissionId: row.submissionId,
      dueAt: campaign.dueAt,
      createdByStaff: g.staffId,
    })),
  });
  await tx.yearEndCampaignEntry.createMany({
    data: rows.map((row) => ({
      tenantId: g.tenantId,
      campaignId: campaign.id,
      clientId: row.clientId,
      submissionId: row.submissionId,
      requestId: row.requestId,
    })),
  });
  return rows.length;
}
