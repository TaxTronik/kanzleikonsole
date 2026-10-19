// =============================================================================
// /staff/clients/:id/tcms/feststellungen — Feststellungen und Maßnahmen (TCMS
// Stufe 3, Bereich C; portiert aus der Demo
// staff/clients/[id]/tcms/feststellungen/page.tsx).
//
// feststellungenLesen (Liste, vertrauliche für Nicht-Beteiligte maskiert) und
// kontextLesen (Kopf, Rechte, Risiken und Durchführungen für das Erfassen)
// parallel; jede Anzeige einer Feststellung über FeststellungBezeichnung bzw.
// die maskierte Zeile. Filter per GET.
// =============================================================================

import { ENDPUNKTE, StandSchema } from '@taxtronik/tcms-contract';
import { TcmsZustand } from '@/components/tcms/zustand';
import { personIdsAus } from '@/server/tcms/namen';
import { tcmsLesenOptional, tcmsMandantSeite, tcmsNamenLesen } from '@/server/tcms/seite';
import { OhneProgramm } from '../durchfuehrungen/liste';
import { FeststellungenListe, filterAus } from './liste';

export const metadata = { title: 'Tax-CMS – Feststellungen' };

type Suche = Record<string, string | string[] | undefined>;

export default async function TcmsFeststellungenPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Suche>;
}) {
  const { id } = await params;
  const seite = await tcmsMandantSeite(id);
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;

  const suche = await searchParams;
  const stand = StandSchema.safeParse(suche.stand);
  const query = stand.success ? { stand: stand.data } : {};
  const [kontext, liste] = await Promise.all([
    tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, { query }),
    tcmsLesenOptional(seite, ENDPUNKTE.feststellungenLesen, { query }),
  ]);
  if (!kontext.ok) return <TcmsZustand zustand={kontext.zustand} />;
  if (!liste.ok) return <TcmsZustand zustand={liste.zustand} />;
  if (kontext.daten === null || liste.daten === null || !kontext.daten.programm) {
    return <OhneProgramm seite={seite} titel="Feststellungen und Maßnahmen" />;
  }

  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(
      liste.daten.feststellungen.flatMap((f) =>
        f.maskiert ? [] : f.massnahmen.map((m) => m.verantwortlich),
      ),
    ),
  );
  return (
    <FeststellungenListe
      seite={seite}
      ctx={kontext.daten}
      liste={liste.daten}
      filter={filterAus(suche)}
      namen={namen}
    />
  );
}
