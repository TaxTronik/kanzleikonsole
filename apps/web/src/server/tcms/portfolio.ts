import 'server-only';

// =============================================================================
// Daten der kanzleikonsole für das Tax-CMS-Portfolio (TCMS Stufe 3).
//
// Das TCMS liefert Kennzahlen nur für Mandanten mit Anker; Namen und
// Zuständigkeiten gehören der kanzleikonsole. Diese Abfrage lädt genau die
// Mandanten der bestätigten Mandantenliste der Seite (keine weiteren) mit
// Name und Berufsträger:innen, damit das Portfolio auch Mandanten ohne Anker
// zeigt und Namen nicht aus dem TCMS übernimmt.
// =============================================================================

import { withTenantContext } from '@taxtronik/db/tenant-context';
import { anzeigename } from './akteur';
import type { TcmsKanzleiSeite } from './seite';

export interface PortfolioMandant {
  id: string;
  name: string;
  berufstraeger: string[];
  /** Die Person ist zuständige Berufsträgerin bzw. Hauptbearbeitung (aus der Mandantenliste). */
  zustaendig: boolean;
}

/** Mandanten der Liste in alphabetischer Reihenfolge (de). */
export async function portfolioMandanten(seite: TcmsKanzleiSeite): Promise<PortfolioMandant[]> {
  const { tenantId, staffId } = seite.session.user;
  const ids = seite.liste.mandantIds;
  if (ids.length === 0) return [];
  const zustaendig = new Set([...seite.liste.bt, ...seite.liste.hb]);
  return withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, async (tx) => {
    const mandanten = await tx.client.findMany({
      where: { tenantId, id: { in: [...ids] } },
      select: { id: true, name: true },
    });
    const zuordnungen = await tx.clientResponsibility.findMany({
      where: { tenantId, clientId: { in: [...ids] }, role: 'BERUFSTRAEGER' },
      select: { clientId: true, staff: { select: { fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const btJe = new Map<string, string[]>();
    for (const z of zuordnungen) {
      let name: string;
      try {
        name = anzeigename(z.staff.fullName);
      } catch {
        continue;
      }
      btJe.set(z.clientId, [...(btJe.get(z.clientId) ?? []), name]);
    }
    return mandanten
      .map((m) => ({
        id: m.id,
        name: m.name,
        berufstraeger: btJe.get(m.id) ?? [],
        zustaendig: zustaendig.has(m.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  });
}
