// =============================================================================
// /staff/clients/:id/tcms/feststellungen/:fid — Feststellung (TCMS Stufe 3,
// Bereich C; portiert aus der Demo
// staff/clients/[id]/tcms/feststellungen/[fid]/page.tsx).
//
// feststellungLesen und kontextLesen (Kopf, Rechte-Kennzeichen, Risiken,
// Kontrollen, Kontaktrollen) parallel. Vertrauliche Feststellungen kommen für
// Nicht-Beteiligte maskiert: dann nur Nummer und Hinweis, keine Bedienung.
// Rechte und §-153-Regeln entscheidet der Dienst; die Seite sperrt nur
// sichtbar nach den Kennzeichen des Kontexts.
// =============================================================================

import { notFound } from 'next/navigation';
import { ENDPUNKTE, ObjektIdSchema, StandSchema } from '@taxtronik/tcms-contract';
import { TcmsZustand } from '@/components/tcms/zustand';
import { massnahmePersonenTx } from '@/server/tcms/feststellungen/personen';
import { personIdsAus } from '@/server/tcms/namen';
import {
  tcmsLesen,
  tcmsLesenOptional,
  tcmsMandantSeite,
  tcmsNamenLesen,
  tcmsTenantLesen,
} from '@/server/tcms/seite';
import { FeststellungAnsicht, MaskierteFeststellung } from './ansicht';

export const metadata = { title: 'Tax-CMS – Feststellung' };

export default async function TcmsFeststellungPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; fid: string }>;
  searchParams: Promise<{ stand?: string | string[] }>;
}) {
  const { id, fid } = await params;
  const seite = await tcmsMandantSeite(id);
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;
  const feststellungId = ObjektIdSchema.safeParse(fid);
  if (!feststellungId.success) notFound();

  const { stand: standRoh } = await searchParams;
  const stand = StandSchema.safeParse(standRoh);
  const query = stand.success ? { stand: stand.data } : {};
  const [gelesen, kontext] = await Promise.all([
    tcmsLesen(seite, ENDPUNKTE.feststellungLesen, {
      params: { feststellungId: feststellungId.data },
      query,
    }),
    tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, { query }),
  ]);
  if (!gelesen.ok) return <TcmsZustand zustand={gelesen.zustand} />;
  if (!kontext.ok) return <TcmsZustand zustand={kontext.zustand} />;
  if (kontext.daten === null) notFound();
  const f = gelesen.daten;
  const ctx = kontext.daten;
  if (f.maskiert) return <MaskierteFeststellung seite={seite} f={f} ctx={ctx} />;

  const offen = f.status !== 'GESCHLOSSEN' && f.status !== 'VERWORFEN';
  const personen =
    !ctx.historisch && ctx.rechte.bearbeiten && offen
      ? await tcmsTenantLesen(seite, (tx) =>
          massnahmePersonenTx(
            tx,
            { tenantId: seite.session.user.tenantId, mandantId: seite.mandantId },
            new Set(ctx.kontaktRollen.map((r) => r.kontaktId.toLowerCase())),
          ),
        )
      : [];
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(
      seite.session.user.staffId,
      f.erfasstVon,
      f.p153?.von,
      [f.verwerfen?.beantragtVon, f.verwerfen?.bestaetigtVon],
      f.massnahmen.flatMap((m) => [m.verantwortlich, m.erledigtVon]),
      f.verlauf.map((v) => v.actorId),
    ),
  );
  return <FeststellungAnsicht seite={seite} f={f} ctx={ctx} namen={namen} personen={personen} />;
}
