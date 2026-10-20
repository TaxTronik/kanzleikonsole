// =============================================================================
// /staff/clients/:id/tcms/kalender — Kontrollkalender und Prüflast je Monat
// (TCMS Stufe 3, portiert aus der Demo staff/clients/[id]/tcms/kalender/page.tsx).
//
// Daten nur aus dem Kontext (`GET …/kontext`): Kontrollen, Durchführungen
// mit Status und Fälligkeit vom Dienst. Die Seite wählt zwölf Monate aus,
// ordnet Durchführungen nach Fälligkeitsmonat und zählt sie je
// Governance-Typ mit `pruflast` aus @taxtronik/tcms-domain (derselben
// Funktion, mit der der Dienst die Prüflast des Cockpits zählt). Filter per
// GET-Links.
//
// Abweichung von der Demo: Statuszellen zeigen ein Symbol je Status (nicht nur
// Farbe), damit der Status ohne Farbwahrnehmung erkennbar ist.
// =============================================================================

import Link from 'next/link';
import { ArrowLeft, ArrowRight, CalendarRange, KeyRound } from 'lucide-react';
import { ENDPUNKTE, type KontextAntwort } from '@taxtronik/tcms-contract';
import {
  ANZEIGE_LABEL,
  frequenzLabel,
  monatSchluessel,
  PARTEI_LABEL,
  pruflast,
  type AnzeigeStatus,
} from '@taxtronik/tcms-domain';
import {
  auswertenKontext,
  kopfDaten,
  standQuery,
  type KontextMitProgramm,
} from '@/components/tcms/bereich-b/laden';
import {
  auswahlParam,
  mitStand,
  param,
  seitenLink,
  standFuerLinks,
  type SuchParameter,
} from '@/components/tcms/bereich-b/seite';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import { alsDatum, isoDatumText } from '@/components/tcms/format';
import { AnzeigeSymbol } from '@/components/tcms/kalender/symbol';
import {
  imZeitraum,
  jeKontrolleUndMonat,
  monatKurz,
  monatPlus,
  zeitfenster,
  type Zeitfenster,
} from '@/components/tcms/kalender/zeitfenster';
import { TcmsKopf } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import { TcmsZustand } from '@/components/tcms/zustand';
import { tcmsLesenOptional, tcmsMandantSeite } from '@/server/tcms/seite';
import { TcmsText } from '@/components/tcms/text';

export const metadata = { title: 'Tax-CMS – Kontrollkalender' };

type Kontrolle = KontextAntwort['kontrollen'][number];
type Durchfuehrung = KontextAntwort['durchfuehrungen'][number];
type Programm = KontextMitProgramm['programm'];
type Aenderung = Record<string, string | null>;

const LEGENDE: readonly AnzeigeStatus[] = [
  'GEPLANT',
  'FAELLIG',
  'IN_DURCHFUEHRUNG',
  'ZUR_GEGENZEICHNUNG',
  'OHNE_BEFUND',
  'MIT_BEFUND',
  'UEBERFAELLIG',
  'ENTFALLEN',
];

const LAST_ZEILEN = [
  { key: 'FP', label: 'FP · periodisch', titel: 'periodisch an festen Zeitpunkten' },
  { key: 'FF', label: 'FF · laufend', titel: 'laufend und anlassbezogen; zuzüglich Auslösungen' },
  {
    key: 'IN',
    label: 'IN · Aufklärung',
    titel: 'gegengezeichnete Aufklärung statt wiederkehrender Kontrolle',
  },
  {
    key: 'ausloesungen',
    label: 'Auslösungen',
    titel: 'außerplanmäßige Durchführungen aus Ereignissen',
  },
] as const;

const PARTEIEN = [
  ['', 'Alle'],
  ['KANZLEI', 'Kanzlei'],
  ['MANDANT', 'Mandant'],
] as const;

/** Durchführungen als Eingabe für `pruflast` (Fälligkeit und Status vom Dienst). */
function lastBasis(durchf: readonly Durchfuehrung[]) {
  return durchf.flatMap((d) => {
    const faellig = alsDatum(d.faelligAm);
    return faellig
      ? [
          {
            faelligAm: faellig,
            gt: d.gt,
            ausserplanmaessig: d.ausserplanmaessig,
            entfallen: d.anzeige === 'ENTFALLEN',
          },
        ]
      : [];
  });
}

/** Zugänglicher Name eines Kalendereintrags (Status nicht nur als Symbol). */
function durchfuehrungLabel(d: Durchfuehrung): string {
  const zusatz = d.ausserplanmaessig ? ' (außerplanmäßig)' : '';
  return `${d.code} ${d.periodeLabel}${zusatz}: ${ANZEIGE_LABEL[d.anzeige]}, fällig ${isoDatumText(d.faelligAm)}`;
}

function durchfuehrungTitel(d: Durchfuehrung): string {
  const zusatz = d.ausserplanmaessig ? ' (außerplanmäßig)' : '';
  return `${d.code} · ${d.periodeLabel}${zusatz} · ${ANZEIGE_LABEL[d.anzeige]} · fällig ${isoDatumText(d.faelligAm)}`;
}

function ZeitraumNavigation({
  fenster,
  programm,
  stand,
  link,
}: {
  fenster: Zeitfenster;
  programm: Programm;
  stand: string;
  link: (a: Aenderung) => string;
}) {
  const wirksamAb = alsDatum(programm.wirksamAb);
  return (
    <nav aria-label="Zeitraum des Kalenders" className="flex flex-wrap items-center gap-2">
      <Link
        href={link({ ab: monatSchluessel(monatPlus(fenster.start, -12)) })}
        className="btn-secondary text-xs py-1"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> 12 Monate zurück
      </Link>
      <span className="text-sm font-semibold min-w-[10rem] text-center" aria-live="polite">
        {monatKurz(fenster.monate[0]!)} – {monatKurz(fenster.monate[11]!)}
      </span>
      <Link
        href={link({ ab: monatSchluessel(monatPlus(fenster.start, 12)) })}
        className="btn-secondary text-xs py-1"
      >
        12 Monate vor <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
      {wirksamAb ? (
        <Link
          href={link({ ab: monatSchluessel(wirksamAb) })}
          className="btn-secondary text-xs py-1"
        >
          Ab Wirksamkeitsbeginn
        </Link>
      ) : null}
      <Link href={link({ ab: `${stand.slice(0, 4)}-01` })} className="btn-secondary text-xs py-1">
        Kalenderjahr {stand.slice(0, 4)}
      </Link>
    </nav>
  );
}

function FilterNavigation({
  partei,
  nurSchluessel,
  link,
}: {
  partei: string;
  nurSchluessel: boolean;
  link: (a: Aenderung) => string;
}) {
  return (
    <nav aria-label="Filter des Kalenders" className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted">Partei</span>
      {PARTEIEN.map(([wert, label]) => (
        <Link
          key={wert || 'alle'}
          href={link({ partei: wert || null })}
          aria-current={partei === wert ? 'page' : undefined}
          className={`${partei === wert ? 'btn-primary' : 'btn-secondary'} text-xs py-1`}
        >
          {label}
        </Link>
      ))}
      <Link
        href={link({ schluessel: nurSchluessel ? null : '1' })}
        className={`${nurSchluessel ? 'btn-primary' : 'btn-secondary'} text-xs py-1`}
      >
        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> nur Schlüsselkontrollen
        <span className="sr-only">{nurSchluessel ? ' (aktiv, Filter aufheben)' : ''}</span>
      </Link>
    </nav>
  );
}

function MonatsKopf({
  fenster,
  programm,
  standMonat,
  zeitraum,
}: {
  fenster: Zeitfenster;
  programm: Programm;
  standMonat: string;
  zeitraum: boolean;
}) {
  return (
    <>
      {fenster.monate.map((m, i) => {
        const jetzt = fenster.schluessel[i] === standMonat;
        const zr = zeitraum && imZeitraum(m, programm.wirksamAb, programm.wirksamBis);
        return (
          <th
            key={fenster.schluessel[i]}
            scope="col"
            className={`th text-center ${zr ? 'bg-surface-raised' : ''} ${jetzt ? 'text-brand-600' : ''}`}
            title={zr ? 'im Wirksamkeitszeitraum' : undefined}
            aria-current={jetzt ? 'date' : undefined}
          >
            {monatKurz(m)}
            {zr ? <span className="sr-only"> (im Wirksamkeitszeitraum)</span> : null}
          </th>
        );
      })}
    </>
  );
}

function KontrolleKopf({ k, href }: { k: Kontrolle; href: string }) {
  return (
    <th scope="row" className="px-3 py-2 text-left font-normal max-w-[20rem]">
      <span className="block truncate" title={`${k.code} · ${k.titel}`}>
        <Link href={href} className="font-medium text-primary hover:underline">
          {k.code}
        </Link>
        {k.schluessel ? (
          <>
            <KeyRound className="inline h-3 w-3 ml-1 text-muted" aria-hidden="true" />
            <span className="sr-only"> (Schlüsselkontrolle)</span>
          </>
        ) : null}
        <span className="text-xs text-secondary">
          {' '}
          · <TcmsText>{k.titel}</TcmsText>
        </span>
      </span>
      <span className="block text-xs text-muted">
        <span className="font-mono">{k.gt ?? '—'}</span> · {frequenzLabel(k.frequenz)} ·{' '}
        {PARTEI_LABEL[k.partei]}
      </span>
    </th>
  );
}

function MonatsZelle({
  liste,
  zeitraum,
  href,
}: {
  liste: readonly Durchfuehrung[];
  zeitraum: boolean;
  href: (d: Durchfuehrung) => string;
}) {
  return (
    <td className={`px-1 py-2 text-center ${zeitraum ? 'bg-surface-raised' : ''}`}>
      {liste.length === 0 ? (
        <span className="text-muted text-xs">
          <span aria-hidden="true">·</span>
          <span className="sr-only">keine</span>
        </span>
      ) : (
        liste.map((d) => (
          <Link
            key={d.id}
            href={href(d)}
            className="inline-flex p-0.5"
            aria-label={durchfuehrungLabel(d)}
            title={durchfuehrungTitel(d)}
          >
            <AnzeigeSymbol status={d.anzeige} ausserplanmaessig={d.ausserplanmaessig} />
          </Link>
        ))
      )}
    </td>
  );
}

function Legende({ programm }: { programm: Programm }) {
  return (
    <div className="card-footer flex-wrap gap-3">
      <ul className="flex flex-wrap gap-3" aria-label="Legende">
        {LEGENDE.map((a) => (
          <li key={a} className="inline-flex items-center gap-1">
            <AnzeigeSymbol status={a} /> {ANZEIGE_LABEL[a]}
          </li>
        ))}
        <li className="inline-flex items-center gap-1">
          <AnzeigeSymbol status="GEPLANT" ausserplanmaessig /> außerplanmäßig (umrandet)
        </li>
      </ul>
      {programm.wirksamAb && programm.wirksamBis ? (
        <span>
          Wirksamkeitszeitraum {isoDatumText(programm.wirksamAb)} –{' '}
          {isoDatumText(programm.wirksamBis)} (hinterlegte Monate hervorgehoben)
        </span>
      ) : null}
    </div>
  );
}

function KalenderTabelle({
  kontrollen,
  durchf,
  fenster,
  programm,
  standMonat,
  kontrolleHref,
  durchfuehrungHref,
}: {
  kontrollen: readonly Kontrolle[];
  durchf: readonly Durchfuehrung[];
  fenster: Zeitfenster;
  programm: Programm;
  standMonat: string;
  kontrolleHref: (k: Kontrolle) => string;
  durchfuehrungHref: (d: Durchfuehrung) => string;
}) {
  const jeZelle = jeKontrolleUndMonat(durchf);
  const imFenster = durchf.filter((d) => {
    const faellig = alsDatum(d.faelligAm);
    return !!faellig && fenster.schluessel.includes(monatSchluessel(faellig));
  });
  return (
    <section className="card" aria-labelledby="tcms-kalender">
      <div className="card-header flex-wrap gap-2">
        <h3 id="tcms-kalender" className="text-sm font-semibold text-primary">
          Kontrollkalender · {kontrollen.length} Kontrollen
        </h3>
        <span className="text-xs text-muted">
          {imFenster.length} Durchführungen im Fenster · nach Fälligkeit
        </span>
      </div>
      {kontrollen.length === 0 ? (
        <TcmsLeer icon={CalendarRange} text="Keine Kontrollen für diesen Filter." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Durchführungen je Kontrolle und Fälligkeitsmonat, {monatKurz(fenster.monate[0]!)} bis{' '}
              {monatKurz(fenster.monate[11]!)}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="th min-w-[14rem]">
                  Kontrolle
                </th>
                <MonatsKopf
                  fenster={fenster}
                  programm={programm}
                  standMonat={standMonat}
                  zeitraum
                />
              </tr>
            </thead>
            <tbody>
              {kontrollen.map((k) => (
                <tr key={k.id} className="border-t border-default">
                  <KontrolleKopf k={k} href={kontrolleHref(k)} />
                  {fenster.monate.map((m, i) => (
                    <MonatsZelle
                      key={fenster.schluessel[i]}
                      liste={jeZelle.get(`${k.id}|${fenster.schluessel[i]}`) ?? []}
                      zeitraum={imZeitraum(m, programm.wirksamAb, programm.wirksamBis)}
                      href={durchfuehrungHref}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Legende programm={programm} />
    </section>
  );
}

function PruflastTabelle({
  durchf,
  fenster,
  programm,
  standMonat,
  gefiltert,
}: {
  durchf: readonly Durchfuehrung[];
  fenster: Zeitfenster;
  programm: Programm;
  standMonat: string;
  gefiltert: boolean;
}) {
  const basis = lastBasis(durchf);
  const last = fenster.schluessel.map((m) => pruflast(basis, m));
  return (
    <section className="card mt-4" aria-labelledby="tcms-prueflast">
      <div className="card-header flex-wrap gap-2">
        <h3 id="tcms-prueflast" className="text-sm font-semibold text-primary">
          Manuelle Prüflast je Monat nach Governance-Typ
        </h3>
        <span className="text-xs text-muted">
          {gefiltert ? 'gefiltert · ' : ''}Durchführungen nach Fälligkeitsmonat, ohne entfallene
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Anzahl Durchführungen je Monat und Governance-Typ</caption>
          <thead>
            <tr>
              <th scope="col" className="th min-w-[14rem]">
                Governance-Typ
              </th>
              <MonatsKopf
                fenster={fenster}
                programm={programm}
                standMonat={standMonat}
                zeitraum={false}
              />
            </tr>
          </thead>
          <tbody>
            {LAST_ZEILEN.map((z) => (
              <tr key={z.key} className="border-t border-default">
                <th scope="row" className="px-3 py-1.5 text-left font-normal" title={z.titel}>
                  <TcmsText>{z.label}</TcmsText>
                </th>
                {last.map((l) => (
                  <td key={l.monat} className="px-1 py-1.5 text-center font-mono">
                    {l[z.key] ? l[z.key] : <span className="text-muted">0</span>}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-default">
              <th scope="row" className="px-3 py-1.5 text-left font-semibold">
                Gesamt
              </th>
              {last.map((l) => (
                <td key={l.monat} className="px-1 py-1.5 text-center font-mono font-semibold">
                  {l.gesamt}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="card-footer flex-wrap gap-2">
        <span>
          Frequenzen aus Governance-Typ × Bruttoklasse (Startwerte, vom Berufsträger zu
          kalibrieren). FF zuzüglich Auslösungen aus Ereignissen.
        </span>
      </div>
    </section>
  );
}

export default async function TcmsKalenderPage({
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
  const kontext = await tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, {
    query: standQuery(sp),
  });
  const geladen = auswertenKontext(seite.basis, kontext, CalendarRange);
  if (!geladen.ok) return geladen.anzeige;
  const { ctx } = geladen;
  const p = ctx.programm;

  const pfad = `${seite.basis}/kalender`;
  const stand = standFuerLinks(ctx);
  const fenster = zeitfenster(param(sp, 'ab'), ctx.stand, p.wirksamAb);
  const partei = auswahlParam(sp, 'partei', ['KANZLEI', 'MANDANT'] as const);
  const nurSchluessel = param(sp, 'schluessel') === '1';
  const behalten = {
    stand,
    ab: fenster.ab,
    partei: partei || null,
    schluessel: nurSchluessel ? '1' : null,
  };
  const link = (aenderung: Aenderung) => seitenLink(pfad, behalten, aenderung);
  const standMonat = monatSchluessel(monatPlus(alsDatum(ctx.stand) ?? new Date(), 0));

  const kontrollen = ctx.kontrollen.filter(
    (k) => (!partei || k.partei === partei) && (!nurSchluessel || k.schluessel),
  );
  const ids = new Set(kontrollen.map((k) => k.id));
  const durchf = ctx.durchfuehrungen.filter((d) => ids.has(d.kontrolleId));

  return (
    <>
      <TcmsKopf
        daten={kopfDaten(ctx)}
        titel={<h2 className="text-lg font-semibold text-primary mr-2">Kontrollkalender</h2>}
      />
      <TcmsPflichthinweis />

      <div className="card mt-4 mb-4 p-3 flex flex-wrap items-center justify-between gap-3">
        <ZeitraumNavigation fenster={fenster} programm={p} stand={ctx.stand} link={link} />
        <FilterNavigation partei={partei} nurSchluessel={nurSchluessel} link={link} />
      </div>

      <KalenderTabelle
        kontrollen={kontrollen}
        durchf={durchf}
        fenster={fenster}
        programm={p}
        standMonat={standMonat}
        kontrolleHref={(k) =>
          mitStand(`${seite.basis}/kontrollen?kontrolle=${encodeURIComponent(k.id)}`, stand)
        }
        durchfuehrungHref={(d) =>
          mitStand(`${seite.basis}/durchfuehrungen/${encodeURIComponent(d.id)}`, stand)
        }
      />
      <PruflastTabelle
        durchf={durchf}
        fenster={fenster}
        programm={p}
        standMonat={standMonat}
        gefiltert={!!partei || nurSchluessel}
      />
    </>
  );
}
