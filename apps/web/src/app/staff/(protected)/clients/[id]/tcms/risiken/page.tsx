// =============================================================================
// /staff/clients/:id/tcms/risiken — Risikoinventar mit Heatmap und
// Risikodetail (TCMS Stufe 3, portiert aus der Demo
// staff/clients/[id]/tcms/risiken/page.tsx).
//
//   1. tcmsMandantSeite(id) als erster Aufruf
//   2. parallel: Kontext (Rechte, Programm, Kontrollen, Ereignisse,
//      Feststellungen, Kontaktrollen) und `GET …/risiken` (Inventar mit
//      Hinweisen und Akzeptanzen); bei geöffnetem Risiko `GET …/risiken/:id`
//   3. Namen aus der kanzleikonsole; gesetzliche Vertretung = aktive Kontakte
//      dieses Mandanten mit aktiver Rolle laut Dienst
//
// Klassen, Appetit, Status und Hinweise berechnet der Dienst; die Seite
// filtert, sortiert und zeigt an (TCMS-DIENST-001).
// =============================================================================

import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { ENDPUNKTE, type KontextAntwort, type RisikoDetail } from '@taxtronik/tcms-contract';
import { SperrHinweis } from '@/components/tcms/bereich-b/detail';
import { auswerten, detailAus, kopfDaten, standQuery } from '@/components/tcms/bereich-b/laden';
import {
  mitStand,
  objektIdParam,
  param,
  seitenLink,
  sperreAus,
  standFuerLinks,
  type SuchParameter,
} from '@/components/tcms/bereich-b/seite';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import { TcmsKopf } from '@/components/tcms/kopf';
import { RisikoDetailBereich, type GesetzlicheVertretung } from '@/components/tcms/risiken/detail';
import {
  filtereRisiken,
  risikoFilterAus,
  risikoFilterParameter,
} from '@/components/tcms/risiken/filter';
import { RisikoFilterFormular } from '@/components/tcms/risiken/filter-formular';
import { freigabeAuswahl, risikoAuditPersonen } from '@/components/tcms/risiken/labels';
import {
  AnsichtUmschalter,
  RisikenHeatmapKarte,
  RisikenListenKarte,
} from '@/components/tcms/risiken/uebersicht';
import { TcmsZustand } from '@/components/tcms/zustand';
import { personIdsAus } from '@/server/tcms/namen';
import { kontakteDesMandantenTx } from '@/server/tcms/personen';
import {
  tcmsLesenOptional,
  tcmsMandantSeite,
  tcmsNamenLesen,
  tcmsTenantLesen,
  type TcmsMandantSeite,
} from '@/server/tcms/seite';
import type { RisikenListe } from '@taxtronik/tcms-contract';
import {
  risikenFreigabeSchrittAction,
  risikoakzeptanzAnfordernAction,
  risikoBewertungBestaetigenAction,
  risikoNeuBewertenAction,
  risikoZurueckweisenAction,
  uebersteuerungBeantragenAction,
  uebersteuerungEntscheidenAction,
} from './actions';
import { TcmsText } from '@/components/tcms/text';

export const metadata = { title: 'Tax-CMS – Risikoinventar' };

/** Personen-IDs der Seite (Inventar, Kontrollen, geöffnetes Risiko). */
function personenDerSeite(
  liste: RisikenListe,
  ctx: KontextAntwort,
  detail: RisikoDetail | null,
): string[] {
  return personIdsAus(
    liste.risiken.flatMap((r) => [
      r.ownerId,
      r.freigabeEingereichtVon,
      r.freigegebenVon,
      ...r.uebersteuerungen.flatMap((u) => [u.beantragtVon, u.entschiedenVon]),
      ...r.akzeptanzen.flatMap((a) => [a.angefordertVon, a.empfaengerId]),
    ]),
    ctx.kontrollen.map((k) => k.designVon),
    detail?.staende.map((s) => s.erstelltVon) ?? [],
    detail?.audit.flatMap((a) => [a.actorId, ...risikoAuditPersonen(a.detail)]) ?? [],
  );
}

/**
 * Gesetzliche Vertretung für die Risikoakzeptanz: Rolle laut Dienst, Kontakt
 * (aktiv, genau dieser Mandant) und Name aus der kanzleikonsole.
 */
async function gesetzlicheVertretung(
  seite: TcmsMandantSeite,
  ctx: KontextAntwort,
): Promise<GesetzlicheVertretung[]> {
  const rolle = new Map(
    ctx.kontaktRollen
      .filter((k) => k.rolle === 'GESETZLICHER_VERTRETER')
      .map((k) => [k.kontaktId.toLowerCase(), k.funktion]),
  );
  const kontakte = await tcmsTenantLesen(seite, (tx) =>
    kontakteDesMandantenTx(tx, {
      tenantId: seite.session.user.tenantId,
      mandantId: seite.mandantId,
    }),
  );
  return kontakte
    .filter((k) => k.aktiv && rolle.has(k.id.toLowerCase()))
    .map((k) => ({
      id: k.id,
      name: k.name,
      funktion: rolle.get(k.id.toLowerCase()) ?? null,
      portal: k.portal,
    }));
}

function InventarLeiste({
  aktiv,
  anzahlNeu,
  vorschlaegeOffen,
  neuHref,
  profilHref,
}: {
  aktiv: number;
  anzahlNeu: number;
  vorschlaegeOffen: number;
  neuHref: string;
  profilHref: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 my-3">
      <span className="badge-gray">{aktiv} aktiv</span>
      {anzahlNeu > 0 ? (
        <Link
          href={neuHref}
          className="badge-yellow"
          title="Ereignis oder Profiländerung nach der letzten Bewertung"
        >
          {anzahlNeu} neu bewerten
        </Link>
      ) : null}
      {vorschlaegeOffen > 0 ? (
        <Link href={profilHref} className="badge-brand">
          {vorschlaegeOffen} Katalogvorschläge offen
        </Link>
      ) : null}
      <span className="text-xs text-muted">
        Risiken entstehen aus dem Katalogvorschlag des Geschäftsprofils.
      </span>
    </div>
  );
}

export default async function TcmsRisikenPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SuchParameter>;
}) {
  const { id } = await params;
  const seite = await tcmsMandantSeite(id);
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;

  const sp = await searchParams;
  const query = standQuery(sp);
  const [kontext, inventar] = await Promise.all([
    tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, { query }),
    tcmsLesenOptional(seite, ENDPUNKTE.risikenLesen, { query }),
  ]);
  const geladen = auswerten(seite.basis, kontext, inventar);
  if (!geladen.ok) return geladen.anzeige;
  const { ctx, daten: liste } = geladen;

  const pfad = `${seite.basis}/risiken`;
  const stand = standFuerLinks(liste);
  const filter = risikoFilterAus(sp);
  const ansicht = param(sp, 'ansicht') === 'heatmap' ? 'heatmap' : 'liste';
  const behalten = {
    stand,
    ...risikoFilterParameter(filter),
    ansicht: ansicht === 'heatmap' ? 'heatmap' : null,
  };
  const gefiltert = filtereRisiken(liste.risiken, filter);
  const auswahlId = objektIdParam(sp, 'risiko');
  const auswahl = liste.risiken.find((r) => r.id === auswahlId) ?? null;
  const detail = detailAus(
    auswahl
      ? await tcmsLesenOptional(seite, ENDPUNKTE.risikoLesen, {
          params: { risikoId: auswahl.id },
          query,
        })
      : null,
  );
  // Recht des Bereichs aus dem Risikoinventar (TCMS s7), wie die Schreiboperationen.
  const sperre = sperreAus(liste);
  const ich = seite.session.user.staffId;
  const namen = await tcmsNamenLesen(
    seite,
    personenDerSeite(liste, ctx, detail?.ok ? detail.daten : null),
  );
  const vertretung =
    auswahl?.ueberAppetit && !sperre ? await gesetzlicheVertretung(seite, ctx) : [];
  const anzahlNeu = liste.risiken.filter((r) => r.hinweise.length > 0).length;
  const detailHref = (risikoId: string) => seitenLink(pfad, behalten, { risiko: risikoId });

  return (
    <>
      <TcmsKopf
        daten={kopfDaten(ctx)}
        titel={<h2 className="text-lg font-semibold text-primary mr-2">Risikoinventar</h2>}
        rechts={
          <AnsichtUmschalter
            aktiv={ansicht}
            optionen={[
              ['liste', 'Liste'],
              ['heatmap', 'Heatmap'],
            ]}
            href={(a) => seitenLink(pfad, behalten, { ansicht: a === 'heatmap' ? a : null })}
          />
        }
      />
      <TcmsPflichthinweis />
      <InventarLeiste
        aktiv={liste.risiken.length}
        anzahlNeu={anzahlNeu}
        vorschlaegeOffen={liste.vorschlaegeOffen}
        neuHref={seitenLink(pfad, { stand }, { neu: '1' })}
        profilHref={mitStand(`${seite.basis}/profil`, stand)}
      />
      <SperrHinweis grund={sperre} />

      <RisikoFilterFormular
        pfad={pfad}
        filter={filter}
        stand={stand}
        ansicht={ansicht}
        anzahlNeu={anzahlNeu}
        ohneHeatmapHref={seitenLink(pfad, behalten, { s: null, w: null })}
        zuruecksetzenHref={seitenLink(pfad, { stand, ansicht: behalten.ansicht })}
      />

      <div
        className={
          auswahl ? 'grid grid-cols-1 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4' : ''
        }
      >
        <section aria-labelledby="tcms-risiken-liste" className="card min-w-0">
          <h3 id="tcms-risiken-liste" className="sr-only">
            {ansicht === 'heatmap' ? 'Heatmap der Risiken' : 'Liste der Risiken'}
          </h3>
          {ansicht === 'heatmap' ? (
            <RisikenHeatmapKarte liste={liste} gefiltert={gefiltert} pfad={pfad} stand={stand} />
          ) : (
            <RisikenListenKarte
              liste={liste}
              gefiltert={gefiltert}
              kontrollen={ctx.kontrollen}
              namen={namen}
              auswahl={freigabeAuswahl(sperre, ich)}
              detailHref={detailHref}
              ausgewaehlt={auswahl?.id ?? null}
              freigabeSchritt={risikenFreigabeSchrittAction.bind(null, seite.mandantId)}
              zuruecksetzenHref={seitenLink(pfad, { stand })}
            />
          )}
        </section>

        {auswahl ? (
          <RisikoDetailBereich
            r={auswahl}
            detail={detail}
            ctx={ctx}
            alle={liste.risiken}
            namen={namen}
            ich={ich}
            sperre={sperre}
            basis={seite.basis}
            stand={stand}
            detailHref={detailHref}
            schliessenHref={seitenLink(pfad, behalten)}
            vertretung={vertretung}
            aktionen={{
              neuBewerten: risikoNeuBewertenAction.bind(null, seite.mandantId),
              bestaetigen: risikoBewertungBestaetigenAction.bind(null, seite.mandantId),
              uebersteuern: uebersteuerungBeantragenAction.bind(null, seite.mandantId),
              entscheiden: uebersteuerungEntscheidenAction.bind(null, seite.mandantId),
              freigabeSchritt: risikenFreigabeSchrittAction.bind(null, seite.mandantId),
              zurueckweisen: risikoZurueckweisenAction.bind(null, seite.mandantId),
              akzeptanz: risikoakzeptanzAnfordernAction.bind(null, seite.mandantId),
            }}
          />
        ) : null}
      </div>

      <p className="text-xs text-muted mt-4 inline-flex items-start gap-1.5">
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
        Klassen berechnet das Tax-CMS (Modell{' '}
        <TcmsText>{liste.risiken[0]?.bewertung.modell ?? 'ec-1.0'}</TcmsText>); übersteuerte Werte
        tragen eine Plakette, der berechnete Wert bleibt sichtbar. Normanker und Startwerte sind
        ungeprüfte Entwürfe. Statusangaben sind Betriebsinformationen.
      </p>
    </>
  );
}
