// =============================================================================
// Ansprechpersonen der Kanzlei für einen Mandanten (TCMS Stufe 3, Bereich D):
// Berufsträgerin und Hauptbearbeitung aus der Zuständigkeit der kanzleikonsole
// (ClientResponsibility, nur aktive Personen), Namen frisch aus der Datenbank.
// Verwendung: Anzeige im Portal und `benachrichtigen` der Portal-Meldung
// (Vertrag: nur für den Postausgang, begründet kein Recht). Mehrere
// Zuordnungen je Rolle: die älteste zuerst (stabil). Keine → null.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { anzeigename } from '@/server/tcms/akteur';

export interface TcmsAnsprechperson {
  id: string;
  name: string;
}

export interface TcmsAnsprechpersonen {
  berufstraeger: TcmsAnsprechperson | null;
  hauptbearbeitung: TcmsAnsprechperson | null;
}

export async function ansprechpersonenTx(
  tx: TxClient,
  bezug: { tenantId: string; mandantId: string },
): Promise<TcmsAnsprechpersonen> {
  const zuordnungen = await tx.clientResponsibility.findMany({
    where: {
      tenantId: bezug.tenantId,
      clientId: bezug.mandantId,
      role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] },
      staff: { active: true },
    },
    orderBy: [{ createdAt: 'asc' }, { staffId: 'asc' }],
    select: { role: true, staff: { select: { id: true, fullName: true } } },
    take: 20,
  });
  const erste = (rolle: 'BERUFSTRAEGER' | 'HAUPTBEARBEITER'): TcmsAnsprechperson | null => {
    for (const z of zuordnungen) {
      if (z.role !== rolle) continue;
      try {
        return { id: z.staff.id.toLowerCase(), name: anzeigename(z.staff.fullName) };
      } catch {
        // leerer Name: nächste Zuordnung
      }
    }
    return null;
  };
  return { berufstraeger: erste('BERUFSTRAEGER'), hauptbearbeitung: erste('HAUPTBEARBEITER') };
}
