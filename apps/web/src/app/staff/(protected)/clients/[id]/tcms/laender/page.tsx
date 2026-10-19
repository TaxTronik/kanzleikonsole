// =============================================================================
// /staff/clients/:id/tcms/laender — Länder-Monitor (TCMS Stufe 3, portiert
// aus der Demo staff/clients/[id]/tcms/laender/page.tsx).
//
//   1. tcmsMandantSeite(id) als erster Aufruf
//   2. parallel: Kontext (Länder mit Registrierungsstatus, Schwelle, Rechte,
//      Geschäftsprofil) und `GET …/laender` (Historie je Land, nicht
//      vertrauliche Feststellungen mit Länderbezug)
//   3. Namen der Erfassenden aus der kanzleikonsole
//
// `?land=XX` öffnet den Detailbereich, `?erfassen=1` die Sammelerfassung
// (nur mit Bearbeitungsrecht laut Dienst und am aktuellen Stand).
// =============================================================================

import Link from 'next/link';
import { Globe, Pencil, Upload, X } from 'lucide-react';
import {
  ENDPUNKTE,
  type Laender as LaenderMonitor,
  type LandStand,
} from '@taxtronik/tcms-contract';
import { EU_LAENDER, fmtEurGanz } from '@taxtronik/tcms-domain';
import { SperrHinweis } from '@/components/tcms/bereich-b/detail';
import type { TcmsAktion } from '@/components/tcms/bereich-b/ergebnis';
import {
  auswerten,
  kopfDaten,
  standQuery,
  type KontextMitProgramm,
} from '@/components/tcms/bereich-b/laden';
import {
  mitStand,
  param,
  seitenLink,
  sperreAus,
  standFuerLinks,
  type SuchParameter,
} from '@/components/tcms/bereich-b/seite';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import { isoDatumText } from '@/components/tcms/format';
import { TcmsKopf } from '@/components/tcms/kopf';
import { profilKanaele } from '@/components/tcms/laender/anzeige';
import {
  LandDetailBereich,
  LaenderTabelle,
  SchwellenKarte,
} from '@/components/tcms/laender/ansicht';
import {
  LandHinzufuegenFormular,
  LandStandFormular,
  SammelErfassung,
  type LandHinzufuegenAktion,
  type LandWerte,
} from '@/components/tcms/laender/formulare';
import { TcmsLeer } from '@/components/tcms/leer';
import { TcmsZustand } from '@/components/tcms/zustand';
import { personIdsAus } from '@/server/tcms/namen';
import { tcmsLesenOptional, tcmsMandantSeite, tcmsNamenLesen } from '@/server/tcms/seite';
import { landHinzufuegenAction, landStaendeSpeichernAction } from './actions';

export const metadata = { title: 'Tax-CMS – Länder-Monitor' };

/** Formularwerte aus dem jüngsten Stand der Historie (Kalendertage wie im Vertrag). */
function werteAus(stand: LandStand): LandWerte {
  return {
    land: stand.land,
    fernverkaeufeLfdEur: stand.fernverkaeufeLfdEur,
    fernverkaeufeVorjahrEur: stand.fernverkaeufeVorjahrEur,
    lagerSeit: stand.lagerSeit,
    oss: stand.oss,
    lokaleUstNr: stand.lokaleUstNr,
    zmRelevant: stand.zmRelevant,
    steuersaetzeGeprueftAm: stand.steuersaetzeGeprueftAm,
    stand: stand.stand,
  };
}

/** „Fernverkäufe … – Datenstand 30.09.2026 (manuell erfasst).“ (Angaben des Dienstes) */
function datenstandText(ctx: KontextMitProgramm): string {
  const basis = 'Fernverkäufe, Lager und Registrierungsstatus je Land';
  if (!ctx.laenderStand) return `${basis}.`;
  const quelle = ctx.laenderQuelle === 'CSV' ? 'CSV-Import' : 'manuell erfasst';
  return `${basis} – Datenstand ${isoDatumText(ctx.laenderStand)} (${quelle}).`;
}

function kanaeleText(kanaele: readonly string[]): string {
  return kanaele.length
    ? ` Verkaufskanäle laut Geschäftsprofil (P1): ${kanaele.join(', ')} – nicht je Land erfasst.`
    : '';
}

function LandFormular({
  aktion,
  stand,
  heute,
}: {
  aktion: TcmsAktion;
  stand: LandStand | null;
  heute: string;
}) {
  return stand ? (
    <LandStandFormular aktion={aktion} land={werteAus(stand)} heute={heute} />
  ) : (
    <p className="text-sm text-muted">Für dieses Land liegt noch kein Stand vor.</p>
  );
}

function ErfassenKnoepfe({
  pfad,
  stand,
  sperre,
  erfassen,
}: {
  pfad: string;
  stand: string | null;
  sperre: string | null;
  erfassen: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap gap-2">
      <button
        type="button"
        className="btn-secondary text-xs py-1"
        disabled
        title="Der CSV-Import folgt; bitte die Daten manuell erfassen."
      >
        <Upload className="h-3.5 w-3.5" aria-hidden="true" /> CSV-Upload
      </button>
      {erfassen ? (
        <Link href={seitenLink(pfad, { stand })} className="btn-secondary text-xs py-1">
          <X className="h-3.5 w-3.5" aria-hidden="true" /> Erfassung schließen
        </Link>
      ) : sperre ? (
        <button type="button" className="btn-secondary text-xs py-1" disabled title={sperre}>
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Daten manuell erfassen
        </button>
      ) : (
        <Link href={seitenLink(pfad, {}, { erfassen: '1' })} className="btn-secondary text-xs py-1">
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Daten manuell erfassen
        </Link>
      )}
    </span>
  );
}

function Erfassung({
  speichern,
  hinzufuegen,
  werte,
  frei,
  heute,
  pfad,
}: {
  speichern: TcmsAktion;
  hinzufuegen: LandHinzufuegenAktion;
  werte: readonly LandWerte[];
  frei: readonly string[];
  heute: string;
  pfad: string;
}) {
  return (
    <>
      {werte.length > 0 ? (
        <SammelErfassung aktion={speichern} laender={werte} heute={heute} zurueck={pfad} />
      ) : null}
      <LandHinzufuegenFormular
        aktion={hinzufuegen}
        frei={frei}
        heute={heute}
        landHref={`${pfad}?land={land}`}
      />
    </>
  );
}

function LaenderListe({
  ctx,
  feststellungen,
  ausgewaehlt,
  erfassenHref,
  landHref,
  feststellungHref,
}: {
  ctx: KontextMitProgramm;
  feststellungen: ReadonlyMap<string, LaenderMonitor['feststellungen'][number]['eintraege']>;
  ausgewaehlt: string | null;
  erfassenHref: string | null;
  landHref: (land: string) => string;
  feststellungHref: (id: string) => string;
}) {
  return (
    <section className="card min-w-0" aria-labelledby="tcms-laender-liste">
      <h3 id="tcms-laender-liste" className="sr-only">
        Länder im Monitor
      </h3>
      {ctx.laender.length === 0 ? (
        <TcmsLeer icon={Globe} text="Im Länder-Monitor sind noch keine Länder erfasst.">
          {erfassenHref ? (
            <Link href={erfassenHref} className="btn-primary">
              Erstes Land erfassen
            </Link>
          ) : null}
        </TcmsLeer>
      ) : (
        <>
          <LaenderTabelle
            laender={ctx.laender}
            feststellungen={feststellungen}
            profil={ctx.profil}
            laenderStand={ctx.laenderStand}
            landHref={landHref}
            feststellungHref={feststellungHref}
            ausgewaehlt={ausgewaehlt}
          />
          <div className="card-footer flex-wrap gap-2">
            <span>
              {ctx.laender.length} Länder im Monitor · Summe lfd. Jahr (EU-Ausland):{' '}
              <span className="font-mono">{fmtEurGanz(ctx.fernverkaeufeLfd)}</span>
            </span>
            <span>Ein Land öffnet Historie, Registrierung und Fristen.</span>
          </div>
        </>
      )}
    </section>
  );
}

export default async function TcmsLaenderPage({
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
  const [kontext, monitor] = await Promise.all([
    tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, { query }),
    tcmsLesenOptional(seite, ENDPUNKTE.laenderLesen, { query }),
  ]);
  const geladen = auswerten(seite.basis, kontext, monitor, Globe);
  if (!geladen.ok) return geladen.anzeige;
  const { ctx, daten } = geladen;

  const pfad = `${seite.basis}/laender`;
  const stand = standFuerLinks(ctx);
  // Recht des Bereichs aus dem Länder-Monitor (TCMS s7), wie die Schreiboperationen.
  const sperre = sperreAus(daten);
  const erfassen = param(sp, 'erfassen') === '1' && !sperre;
  // Nur ein Land, das der Dienst im Monitor führt.
  const landParam = param(sp, 'land');
  const auswahl = ctx.laender.find((l) => l.land === landParam) ?? null;
  const historie = new Map(daten.historie.map((h) => [h.land, h.staende]));
  const feststellungen = new Map(daten.feststellungen.map((f) => [f.land, f.eintraege]));
  const juengster =
    daten.historie
      .flatMap((h) => h.staende.slice(0, 1))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(daten.historie.flatMap((h) => h.staende.map((s) => s.erfasstVon))),
  );
  const vorhanden = new Set(ctx.laender.map((l) => l.land));
  const feststellungHref = (fid: string) =>
    mitStand(`${seite.basis}/feststellungen/${encodeURIComponent(fid)}`, stand);
  const speichern = landStaendeSpeichernAction.bind(null, seite.mandantId);

  return (
    <>
      <TcmsKopf
        daten={kopfDaten(ctx)}
        titel={
          <h2 className="text-lg font-semibold text-primary mr-2">
            Länder-Monitor – Umsatzsteuer & Registrierungen
          </h2>
        }
        rechts={<ErfassenKnoepfe pfad={pfad} stand={stand} sperre={sperre} erfassen={erfassen} />}
      />
      <TcmsPflichthinweis />
      <p className="text-sm text-muted mt-3">{datenstandText(ctx)}</p>
      <SperrHinweis grund={sperre} />

      <SchwellenKarte ctx={ctx} juengster={juengster} namen={namen} />

      {erfassen ? (
        <Erfassung
          speichern={speichern}
          hinzufuegen={landHinzufuegenAction.bind(null, seite.mandantId)}
          werte={ctx.laender.flatMap((l) => {
            const letzter = historie.get(l.land)?.[0];
            return letzter ? [werteAus(letzter)] : [];
          })}
          frei={EU_LAENDER.filter((l) => l !== 'DE' && !vorhanden.has(l))}
          heute={ctx.heute}
          pfad={pfad}
        />
      ) : null}

      <div
        className={`mt-4 ${auswahl ? 'grid grid-cols-1 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4' : ''}`}
      >
        <LaenderListe
          ctx={ctx}
          feststellungen={feststellungen}
          ausgewaehlt={auswahl?.land ?? null}
          erfassenHref={sperre ? null : `${seitenLink(pfad, {}, { erfassen: '1' })}#land-neu`}
          landHref={(land) => seitenLink(pfad, { stand }, { land })}
          feststellungHref={feststellungHref}
        />

        {auswahl ? (
          <LandDetailBereich
            l={auswahl}
            historie={historie.get(auswahl.land) ?? []}
            feststellungen={feststellungen.get(auswahl.land) ?? []}
            profil={ctx.profil}
            namen={namen}
            sperre={sperre}
            feststellungHref={feststellungHref}
            schliessenHref={seitenLink(pfad, { stand })}
            formular={
              <LandFormular
                aktion={speichern}
                stand={historie.get(auswahl.land)?.[0] ?? null}
                heute={ctx.heute}
              />
            }
          />
        ) : null}
      </div>

      <p className="alert-info-sm mt-4">
        Manuelle Erfassung: Jede Erfassung legt einen neuen Stand an. Automatisierte Importe
        (Plattform-, Zahlungsreports, DATEV) folgen.
        {kanaeleText(profilKanaele(ctx.profil))}
      </p>
    </>
  );
}
