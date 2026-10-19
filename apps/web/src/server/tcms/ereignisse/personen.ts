// =============================================================================
// Personen für die Triage von Ereignissen (TCMS Stufe 3, Bereich D).
//
// Zuständigkeit einer Folge (`PersonZuweisungSchema` des Vertrags: ID + Art
// KANZLEI/MANDANT). Das Formular sendet `K:<uuid>` bzw. `M:<uuid>`; die Aktion
// prüft jede Person in der kanzleikonsole, bevor der Dienst gerufen wird:
//   - KANZLEI: aktive Mitarbeiter mit Zugriff auf den Mandanten
//     (kanzleiPersonenFuerMandantTx, ACCESS-CLIENT-MODE-001),
//   - MANDANT: aktive Kontakte genau dieses Mandanten (mandantKontakteTx).
// Ob ein Kontakt eine aktive Rolle im Tax-CMS hat, prüft der Dienst.
// Auswahllisten nur mit derselben Zugriffsregel (Leitfaden Abschnitt 4).
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { filterStaffAccessClientTx } from '@/server/auth/rbac';
import {
  kanzleiPersonenFuerMandantTx,
  mandantKontakteTx,
  TcmsPersonUnzulaessig,
  type TcmsMandantBezug,
} from '@/server/tcms/personen';

const ZUWEISUNG = /^([KM]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Höchstzahl Mitarbeiter in einer Auswahlliste (eine Kanzlei hat weniger). */
const MAX_AUSWAHL = 500;

export interface TcmsZuweisung {
  id: string;
  art: 'KANZLEI' | 'MANDANT';
}

export interface TcmsPersonOption {
  /** Formularwert `K:<uuid>` bzw. `M:<uuid>`. */
  wert: string;
  label: string;
}

/** Formularwert → Zuweisung; leer → null; alles andere ist unzulässig. */
export function zuweisungAusFormular(wert: string | undefined, feld: string): TcmsZuweisung | null {
  if (wert === undefined || wert === '') return null;
  const treffer = ZUWEISUNG.exec(wert);
  if (!treffer) throw new TcmsPersonUnzulaessig('KANZLEI', feld);
  return {
    id: treffer[2]!.toLowerCase(),
    art: treffer[1]!.toUpperCase() === 'K' ? 'KANZLEI' : 'MANDANT',
  };
}

/**
 * Prüft Zuweisungen gegen die kanzleikonsole (eine Abfrage je Art). Unzulässig
 * → TcmsPersonUnzulaessig am Feld der ersten betroffenen Zeile; kein Dienstaufruf.
 */
export async function pruefeZuweisungenTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
  zuweisungen: ReadonlyArray<{ feld: string; zuweisung: TcmsZuweisung | null }>,
): Promise<void> {
  for (const art of ['KANZLEI', 'MANDANT'] as const) {
    const eintraege = zuweisungen.filter((z) => z.zuweisung?.art === art);
    for (const eintrag of eintraege) {
      // Einzeln, damit der Feldfehler an der richtigen Zeile steht.
      const ids = [eintrag.zuweisung!.id];
      if (art === 'KANZLEI')
        await kanzleiPersonenFuerMandantTx(tx, bezug, ids, { feld: eintrag.feld });
      else await mandantKontakteTx(tx, bezug, ids, { feld: eintrag.feld });
    }
  }
}

/** Aktive Mitarbeiter des Tenants mit Zugriff auf den Mandanten (Auswahlliste). */
export async function kanzleiPersonenAuswahlTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
): Promise<TcmsPersonOption[]> {
  const staff = await tx.staffUser.findMany({
    where: { tenantId: bezug.tenantId, active: true },
    select: { id: true, fullName: true },
    orderBy: { fullName: 'asc' },
    take: MAX_AUSWAHL,
  });
  const erlaubt = await filterStaffAccessClientTx(
    tx,
    bezug.tenantId,
    staff.map((s) => s.id.toLowerCase()),
    bezug.mandantId,
  );
  return staff
    .filter((s) => erlaubt.has(s.id.toLowerCase()) && s.fullName.trim() !== '')
    .map((s) => ({ wert: `K:${s.id.toLowerCase()}`, label: `${s.fullName.trim()} (Kanzlei)` }));
}

/** Standard-Zuständigkeiten aus der kanzleikonsole (nur Vorbelegung der Auswahl). */
export async function zustaendigkeitTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
): Promise<{ berufstraeger: string | null; hauptbearbeitung: string | null }> {
  const zuordnungen = await tx.clientResponsibility.findMany({
    where: {
      tenantId: bezug.tenantId,
      clientId: bezug.mandantId,
      role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] },
      staff: { active: true },
    },
    orderBy: [{ createdAt: 'asc' }, { staffId: 'asc' }],
    select: { role: true, staffId: true },
  });
  const erste = (rolle: string) => zuordnungen.find((z) => z.role === rolle)?.staffId ?? null;
  const bt = erste('BERUFSTRAEGER');
  const hb = erste('HAUPTBEARBEITER');
  return {
    berufstraeger: bt ? `K:${bt.toLowerCase()}` : null,
    hauptbearbeitung: hb ? `K:${hb.toLowerCase()}` : null,
  };
}
