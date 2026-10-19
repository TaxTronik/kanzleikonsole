// =============================================================================
// /staff/clients/:id/tcms/kommunikation — Freigaben, Kenntnisnahmen und
// Meldewege des Tax-CMS (TCMS Stufe 3, Bereich A; portiert aus der Demo
// staff/clients/[id]/tcms/kommunikation/page.tsx).
//
// `freigabenHistorieLesen` liefert alle Anforderungen mit Status zum Stichtag,
// `kontextLesen` Ziele, Beschreibungen, die Kenntnisnahme-Kontrolle K-EC-22,
// Portal-Meldungen und Rollen. Neu gegenüber der Demo: offene Anforderungen
// lassen sich an eine andere (oder dieselbe) Person des Mandanten richten
// (Neuadressierung, TS-06); zur Auswahl stehen nur Kontakte dieses Mandanten
// mit Rolle im Tax-CMS, ob die Rolle passt, entscheidet der Dienst.
// =============================================================================

import Link from 'next/link';
import { Info, MessagesSquare } from 'lucide-react';
import { ENDPUNKTE, StandSchema } from '@taxtronik/tcms-contract';
import { TcmsKopf } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import { rollenAusKontext } from '@/components/tcms/programm/kontakte';
import { TcmsZustand } from '@/components/tcms/zustand';
import { personIdsAus } from '@/server/tcms/namen';
import {
  tcmsLesen,
  tcmsLesenOptional,
  tcmsMandantSeite,
  tcmsNamenLesen,
  type TcmsMandantSeite,
} from '@/server/tcms/seite';
import {
  FreigabenKarte,
  FreigabestaendeKarte,
  KenntnisnahmenKarte,
  KulturKarte,
  type KommunikationModell,
} from './teile';

export const metadata = { title: 'Tax-CMS – Kommunikation' };

const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const UEBERSCHRIFT = <h2 className="text-lg font-semibold text-primary mr-2">Kommunikation</h2>;

function OhneProgramm({
  seite,
  kopf,
}: {
  seite: TcmsMandantSeite;
  kopf: { historisch: boolean; stand: string; heute: string } | null;
}) {
  return (
    <>
      {kopf ? (
        <TcmsKopf
          daten={{ teilbereich: null, aktivePhase: null, ausgeblendet: 0, ...kopf }}
          titel={UEBERSCHRIFT}
        />
      ) : null}
      <div className="card">
        <TcmsLeer
          icon={MessagesSquare}
          text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet."
        >
          <Link className="btn-primary" href={seite.basis}>
            Zum Cockpit
          </Link>
        </TcmsLeer>
      </div>
    </>
  );
}

export default async function TcmsKommunikationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ stand?: string | string[] }>;
}) {
  const { id } = await params;
  const seite = await tcmsMandantSeite(id);
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;

  const standRoh = StandSchema.safeParse(eins((await searchParams).stand));
  const query = standRoh.success ? { stand: standRoh.data } : {};
  const kontext = await tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, { query });
  if (!kontext.ok) return <TcmsZustand zustand={kontext.zustand} />;
  const ctx = kontext.daten;
  if (ctx === null || ctx.programm === null) {
    return (
      <OhneProgramm
        seite={seite}
        kopf={ctx ? { historisch: ctx.historisch, stand: ctx.stand, heute: ctx.heute } : null}
      />
    );
  }
  const historie = await tcmsLesen(seite, ENDPUNKTE.freigabenHistorieLesen, { query });
  if (!historie.ok) return <TcmsZustand zustand={historie.zustand} />;
  const h = historie.daten;

  const rollen = rollenAusKontext(ctx.kontaktRollen);
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(
      h.freigaben.flatMap((f) => [f.empfaengerId, f.angefordertVon]),
      rollen.map((r) => r.kontaktId),
      ctx.ziele.map((z) => z.freigegebenVon),
      ctx.beschreibungen.map((b) => b.freigegebenVon),
      ctx.kontrollen.find((k) => k.code === 'K-EC-22')?.designVon,
    ),
  );
  const m: KommunikationModell = {
    mandantId: seite.mandantId,
    basis: seite.basis,
    ctx,
    h,
    namen,
    rollen,
    neuAdressierbar: ctx.rechte.bearbeiten && !h.historisch,
  };

  return (
    <>
      <TcmsKopf
        daten={{
          teilbereich: ctx.teilbereich,
          aktivePhase: ctx.programm.version1Am ? ctx.aktivePhase : null,
          historisch: ctx.historisch,
          stand: ctx.stand,
          heute: ctx.heute,
          ausgeblendet: ctx.ausgeblendet,
        }}
        titel={UEBERSCHRIFT}
      />
      <p className="alert-info mb-4 text-sm flex items-start gap-2" role="note">
        <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          <strong>Richtlinienverwaltung folgt in Ausbaustufe B.</strong> Bis dahin zeigt diese Seite
          Freigaben und Kenntnisnahmen aus dem Portal. Freigaben erteilen ausschließlich die
          gesetzlichen Vertreter mit E-Mail-Code.
        </span>
      </p>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <div className="xl:col-span-2 space-y-4">
          <FreigabenKarte m={m} />
          <KenntnisnahmenKarte m={m} />
        </div>
        <div className="space-y-4">
          <FreigabestaendeKarte m={m} />
          <KulturKarte m={m} />
        </div>
      </div>
    </>
  );
}
