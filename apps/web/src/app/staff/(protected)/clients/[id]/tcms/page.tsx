// =============================================================================
// /staff/clients/:id/tcms — Tax-CMS-Cockpit des Mandanten (TCMS Stufe 3,
// portiert aus der Demo staff/clients/[id]/tcms/page.tsx). Referenzseite für
// alle weiteren TCMS-Seiten (docs/development/tcms-oberflaechen.md):
//
//   1. tcmsMandantSeite(id) als erster Aufruf (Zugriff, Modul, Dienst, Akteur)
//   2. tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, …) – außerhalb jeder
//      Transaktion; 404 = Mandant noch nicht im Tax-CMS angelegt
//   3. tcmsNamenLesen(seite, ids) – Personennamen aus der kanzleikonsole
//   4. rendern; Fehlerzustände über <TcmsZustand>
//
// Alle Zahlen, Phasen, Klassen und Rechte kommen aus der Antwort des Dienstes;
// die Seite wählt nur aus, was sie zeigt.
// =============================================================================

import { ENDPUNKTE, StandSchema } from '@taxtronik/tcms-contract';
import { TcmsZustand } from '@/components/tcms/zustand';
import { personIdsAus } from '@/server/tcms/namen';
import { tcmsLesenOptional, tcmsMandantSeite, tcmsNamenLesen } from '@/server/tcms/seite';
import { Cockpit, faelligeDurchfuehrungen, NichtAngelegt } from './cockpit';

export const metadata = { title: 'Tax-CMS – Cockpit' };

export default async function TcmsCockpitPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ stand?: string | string[] }>;
}) {
  const { id } = await params;
  const seite = await tcmsMandantSeite(id);
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;

  // Stichtag nur als gültiger Kalendertag weitergeben; sonst aktueller Stand.
  const { stand: standRoh } = await searchParams;
  const stand = StandSchema.safeParse(standRoh);
  const kontext = await tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, {
    query: stand.success ? { stand: stand.data } : {},
  });
  if (!kontext.ok) return <TcmsZustand zustand={kontext.zustand} />;
  if (kontext.daten === null) return <NichtAngelegt seite={seite} />;

  const ctx = kontext.daten;
  const faellige = faelligeDurchfuehrungen(ctx);
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(
      faellige.map((d) =>
        d.anzeige === 'ZUR_GEGENZEICHNUNG' ? d.gegenzeichnerId : d.durchfuehrendId,
      ),
      ctx.ereignisse.filter((e) => e.status === 'NEU').map((e) => e.gemeldetVon),
    ),
  );
  return <Cockpit seite={seite} ctx={ctx} faellige={faellige} namen={namen} />;
}
