// =============================================================================
// /staff/clients/:id/tcms/durchfuehrungen/:did — Kontrolldurchführung (TCMS
// Stufe 3, Bereich C; portiert aus der Demo
// staff/clients/[id]/tcms/durchfuehrungen/[did]/page.tsx).
//
//   1. tcmsMandantSeite(id) als erster Aufruf
//   2. durchfuehrungLesen und kontextLesen (Kopf, Governance-Typ, Frequenz)
//      parallel, außerhalb jeder Transaktion
//   3. Daten der kanzleikonsole: Abgleich der Nachweise mit der Ablage,
//      wählbare Dokumente, Berufsträger (Anzeige)
//   4. Namen aus der kanzleikonsole
//
// Rechte, Status und Vier-Augen kommen aus `rechte` der Antwort; die Seite
// zeigt sie an und bietet nur an, was der Dienst erlaubt.
// =============================================================================

import { notFound } from 'next/navigation';
import { DurchfuehrungIdSchema, ENDPUNKTE, StandSchema } from '@taxtronik/tcms-contract';
import { TcmsZustand } from '@/components/tcms/zustand';
import { durchfuehrungKanzleiDatenTx } from '@/server/tcms/durchfuehrung/kanzlei-daten';
import { personIdsAus } from '@/server/tcms/namen';
import {
  tcmsLesen,
  tcmsLesenOptional,
  tcmsMandantSeite,
  tcmsNamenLesen,
  tcmsTenantLesen,
} from '@/server/tcms/seite';
import { DurchfuehrungAnsicht } from './ansicht';

export const metadata = { title: 'Tax-CMS – Kontrolldurchführung' };

export default async function TcmsDurchfuehrungPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; did: string }>;
  searchParams: Promise<{ stand?: string | string[] }>;
}) {
  const { id, did } = await params;
  const seite = await tcmsMandantSeite(id);
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;
  const durchfuehrungId = DurchfuehrungIdSchema.safeParse(did);
  if (!durchfuehrungId.success) notFound();

  const { stand: standRoh } = await searchParams;
  const stand = StandSchema.safeParse(standRoh);
  const query = stand.success ? { stand: stand.data } : {};
  const [gelesen, kontext] = await Promise.all([
    tcmsLesen(seite, ENDPUNKTE.durchfuehrungLesen, {
      params: { durchfuehrungId: durchfuehrungId.data },
      query,
    }),
    tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, { query }),
  ]);
  if (!gelesen.ok) return <TcmsZustand zustand={gelesen.zustand} />;
  if (!kontext.ok) return <TcmsZustand zustand={kontext.zustand} />;
  const d = gelesen.daten;
  // Mandant ohne Tax-CMS: keine Durchführung (der Dienst hätte 404 geliefert).
  if (kontext.daten === null) notFound();

  const anhaengbar = !d.historisch && d.rechte.bearbeiten.erlaubt && d.status !== 'GEPLANT';
  const kanzlei = await tcmsTenantLesen(seite, (tx) =>
    durchfuehrungKanzleiDatenTx(
      tx,
      { tenantId: seite.session.user.tenantId, mandantId: seite.mandantId },
      d,
      { mitDokumenten: anhaengbar },
    ),
  );
  const k = d.kontrolle;
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(
      seite.session.user.staffId,
      [k.durchfuehrendId, k.vertretungId, k.gegenzeichnerId, k.designVon],
      [d.durchgefuehrtVon, d.gegengezeichnetVon, d.mandantBestaetigtVon, d.zurueckgewiesenVon],
      [d.entfallenVon, d.entfallenFreigegebenVon],
      d.nachweise.map((n) => n.hochgeladenVon),
      d.verlauf.map((v) => v.actorId),
      kanzlei.berufstraeger,
    ),
  );
  return (
    <DurchfuehrungAnsicht
      seite={seite}
      d={d}
      ctx={kontext.daten}
      kanzlei={kanzlei}
      namen={namen}
      anhaengbar={anhaengbar}
    />
  );
}
