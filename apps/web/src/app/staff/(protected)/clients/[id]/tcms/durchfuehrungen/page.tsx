// =============================================================================
// /staff/clients/:id/tcms/durchfuehrungen — Kontrolldurchführungen des
// Mandanten als Liste (TCMS Stufe 3, Bereich C; neu, Vorlage Kontrollkalender
// der Demo). Daten aus `kontextLesen` (Durchführungen mit Status zum Stichtag,
// Nachweiszahl, Zuständigkeit); Filter per GET. Kein eigener Status: Gruppen
// und Sortierung nur zur Anzeige.
// =============================================================================

import { ENDPUNKTE, StandSchema } from '@taxtronik/tcms-contract';
import { TcmsZustand } from '@/components/tcms/zustand';
import { personIdsAus } from '@/server/tcms/namen';
import { tcmsLesenOptional, tcmsMandantSeite, tcmsNamenLesen } from '@/server/tcms/seite';
import { DurchfuehrungenListe, durchfuehrungenGefiltert, filterAus, OhneProgramm } from './liste';

export const metadata = { title: 'Tax-CMS – Durchführungen' };

type Suche = Record<string, string | string[] | undefined>;

export default async function TcmsDurchfuehrungenPage({
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
  const kontext = await tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, {
    query: stand.success ? { stand: stand.data } : {},
  });
  if (!kontext.ok) return <TcmsZustand zustand={kontext.zustand} />;
  if (kontext.daten === null || !kontext.daten.programm) return <OhneProgramm seite={seite} />;

  const ctx = kontext.daten;
  const filter = filterAus(suche);
  const { zeilen } = durchfuehrungenGefiltert(ctx, filter);
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(
      zeilen.map((d) =>
        d.anzeige === 'ZUR_GEGENZEICHNUNG' ? d.gegenzeichnerId : d.durchfuehrendId,
      ),
      zeilen.map((d) => d.durchgefuehrtVon),
    ),
  );
  return <DurchfuehrungenListe seite={seite} ctx={ctx} filter={filter} namen={namen} />;
}
