// =============================================================================
// Stammdaten des Mandantenankers im TCMS (TCMS Stufe 3; ADR 0001 §5 im
// TCMS-Repo: `PUT /v1/mandanten/:mandantId` mit Name, Rechtsform, DATEV-Nr.).
//
// Quelle ist ausschließlich die kanzleikonsole – nie ein Formularfeld:
//   - name:       Client.name
//   - rechtsform: Rechtsform der jüngsten verifizierten GwG-Prüfung
//                 (GwgCheck.legalForm, § 11 Abs. 4 Nr. 2 GwG), sonst die Art
//                 des Mandanten (Natürliche/Juristische Person,
//                 Personengesellschaft)
//   - datevNr:    Client.datevNo, nur wenn rein numerisch (Vertrag: 1–20 Ziffern)
// Steuer- und Richtungszeichen werden für die einzeiligen Felder des Vertrags
// durch Leerzeichen ersetzt; das Ergebnis wird mit dem Schema des Vertrags
// geprüft, bevor es gesendet wird.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { MandantAnkerBodySchema } from '@taxtronik/tcms-contract';
import type { z } from 'zod';
import { CLIENT_KIND_LABELS } from '@/lib/domain-labels';
import { ActionError } from '@/server/actions/action-error';

export type MandantAnker = z.input<typeof MandantAnkerBodySchema>;

// Steuerzeichen (Cc) und Formatzeichen (Cf, u. a. Richtungs- und Nullbreitenzeichen):
// strenger als die Prüfung des Vertrags, nie lockerer.
const STEUERZEICHEN = /[\p{Cc}\p{Cf}]/gu;

/** Einzeiliger Text wie im Anker (Steuer-/Richtungszeichen → Leerzeichen, gekürzt). */
export function einzeilig(wert: string, max: number): string {
  let text = '';
  for (const zeichen of wert.replace(STEUERZEICHEN, ' ').replace(/\s+/g, ' ').trim()) {
    if (text.length + zeichen.length > max) break;
    text += zeichen;
  }
  return text.trim();
}

/** Name, wie ihn der Anker im TCMS trägt (Vergleich „Stammdaten abweichend“). */
export function ankerName(name: string): string {
  return einzeilig(name, 200);
}

/** Stammdaten für den Anker aus der kanzleikonsole (in einer Tenant-Transaktion). */
export async function mandantAnkerTx(
  tx: TxClient,
  tenantId: string,
  mandantId: string,
): Promise<MandantAnker> {
  const mandant = await tx.client.findFirst({
    where: { id: mandantId, tenantId },
    select: { name: true, kind: true, datevNo: true },
  });
  if (!mandant) throw new ActionError('Mandant nicht gefunden.');
  const pruefung = await tx.gwgCheck.findFirst({
    where: { tenantId, clientId: mandantId, status: 'VERIFIED', legalForm: { not: null } },
    orderBy: [{ verifiedAt: 'desc' }, { createdAt: 'desc' }],
    select: { legalForm: true },
  });
  const rechtsform =
    einzeilig(pruefung?.legalForm ?? '', 50) || einzeilig(CLIENT_KIND_LABELS[mandant.kind], 50);
  const datevNr = mandant.datevNo && /^[0-9]{1,20}$/.test(mandant.datevNo) ? mandant.datevNo : null;
  const anker = { name: ankerName(mandant.name), rechtsform, datevNr };
  if (!MandantAnkerBodySchema.safeParse(anker).success) {
    throw new ActionError(
      'Name oder Rechtsform des Mandanten lassen sich nicht an das Tax-CMS übergeben. Bitte die Stammdaten prüfen.',
    );
  }
  return anker;
}
