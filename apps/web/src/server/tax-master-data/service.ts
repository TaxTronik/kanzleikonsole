import { createHash } from 'node:crypto';
import type { TxClient } from '@taxtronik/db';
import { normalizeTaxNumber, type TaxMasterDraft } from '@/lib/tax-registration';
import { ActionError } from '@/server/actions/staff-action';
import { evidenceService } from '@/server/container';
import { TaxMasterDataSchema } from './schema';

export async function loadTaxMasterDataTx(tx: TxClient, tenantId: string, clientId: string) {
  const client = await tx.client.findFirst({
    where: { id: clientId, tenantId },
    select: {
      vatId: true,
      anonymizedAt: true,
      taxRegistrations: { where: { archivedAt: null }, orderBy: { id: 'asc' } },
    },
  });
  if (!client) throw new ActionError('Mandant nicht gefunden.');
  const draft: TaxMasterDraft = {
    vatId: client.vatId ?? '',
    registrations: client.taxRegistrations.map((row) => {
      if (!row.numberElster)
        throw new ActionError(
          'Aktive Steuerverbindung ohne Steuernummer. Bitte Datenbestand prüfen.',
        );
      return {
        id: row.id,
        label: row.label,
        stateCode: row.stateCode ?? '',
        number: row.numberElster,
        taxOfficeName: row.taxOfficeName,
        isPrimary: row.isPrimary,
      };
    }),
  };
  return {
    draft,
    anonymized: Boolean(client.anonymizedAt),
    revision: createHash('sha256').update(JSON.stringify(draft)).digest('hex'),
  };
}

/** TAX-MASTER-DATA-001: serialized complete replacement; omitted rows are archived. */
export async function saveTaxMasterDataTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    staffId: string;
    expectedRevision: string;
    draft: unknown;
  },
) {
  const parsed = TaxMasterDataSchema.safeParse(input.draft);
  if (!parsed.success)
    throw new ActionError(parsed.error.issues[0]?.message ?? 'Ungültige Steuerdaten.');
  const { tenantId, clientId } = input;
  await tx.$queryRaw`SELECT id FROM client WHERE id = ${clientId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
  const before = await loadTaxMasterDataTx(tx, tenantId, clientId);
  if (before.anonymized)
    throw new ActionError(
      'Für anonymisierte Mandanten können keine Steuerdaten gespeichert werden.',
    );
  if (before.revision !== input.expectedRevision)
    throw new ActionError(
      'Steuerdaten wurden inzwischen geändert. Bitte neu laden und den Vorschlag erneut prüfen.',
    );
  const knownIds = new Set(before.draft.registrations.map((row) => row.id));
  if (parsed.data.registrations.some((row) => row.id && !knownIds.has(row.id)))
    throw new ActionError('Steuerverbindung gehört nicht zum aktuellen Mandantenstand.');
  // Temporarily archive all rows inside the transaction so exchanging two
  // numbers cannot hit the active-number unique index between updates.
  await tx.clientTaxRegistration.updateMany({
    where: { tenantId, clientId, archivedAt: null },
    data: { isPrimary: false, archivedAt: new Date() },
  });
  for (const row of parsed.data.registrations) {
    const numberElster = normalizeTaxNumber(row.number, row.stateCode);
    const data = {
      label: row.label,
      stateCode: row.stateCode || null,
      numberElster,
      taxOfficeName: row.taxOfficeName,
      taxOfficeCode: numberElster.slice(0, 4),
      isPrimary: row.isPrimary,
      archivedAt: null,
    };
    if (row.id) await tx.clientTaxRegistration.update({ where: { id: row.id }, data });
    else await tx.clientTaxRegistration.create({ data: { tenantId, clientId, ...data } });
  }
  await tx.client.update({ where: { id: clientId }, data: { vatId: parsed.data.vatId || null } });
  const after = await loadTaxMasterDataTx(tx, tenantId, clientId);
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: input.staffId,
    action: 'client.tax_master_data.update',
    resourceType: 'client',
    resourceId: clientId,
    before: before.draft,
    after: { ...after.draft, gwgReverificationTriggered: false },
  });
  return after;
}
