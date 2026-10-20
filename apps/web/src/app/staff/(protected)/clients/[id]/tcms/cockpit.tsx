// =============================================================================
// Darstellung des Tax-CMS-Cockpits (TCMS Stufe 3). Reine Anzeige der Antwort
// von `GET /v1/mandanten/:id/kontext`; Personennamen kommen aufgelöst herein.
// =============================================================================

import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import {
  ArrowRight,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Circle,
  Inbox,
  Lock,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import type { KontextAntwort } from '@taxtronik/tcms-contract';
import {
  EREIGNIS_QUELLE_LABEL,
  FESTSTELLUNG_STATUS_LABEL,
  KLASSE_LABEL,
  LAND_NAME,
  MONATE,
  P153_LABEL,
  PARTEI_LABEL,
  ereignistyp,
  fmtEurGanz,
  frequenzLabel,
  relativTage,
} from '@taxtronik/tcms-domain';
import { AnzeigeBadge } from '@/components/tcms/badges';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import { FeststellungBezeichnung, VERTRAULICH_HINWEIS } from '@/components/tcms/feststellung';
import {
  alsDatum,
  isoDatumKurzText,
  isoDatumText,
  isoTageZwischen,
} from '@/components/tcms/format';
import { RisikoHeatmap } from '@/components/tcms/heatmap';
import { KatalogIcon } from '@/components/tcms/icon';
import { TcmsKopf } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import { tonChip } from '@/components/tcms/ton';
import {
  BalkenZeilen,
  Fortschritt,
  PhasenStepper,
  SchwellenAnzeige,
  SegmentBalken,
} from '@/components/tcms/visual';
import { ankerName } from '@/server/tcms/mandant';
import type { TcmsNamen } from '@/server/tcms/namen';
import type { TcmsMandantSeite } from '@/server/tcms/seite';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import { MandantAnlegenFormular } from './mandant-anlegen';
import { TcmsText } from '@/components/tcms/text';

type Durchfuehrung = KontextAntwort['durchfuehrungen'][number];

/** Grundelement → Unterseite, auf der seine Lücken bearbeitet werden. */
const GRUNDELEMENT_ZIEL: Readonly<Record<string, string>> = {
  risiken: '/risiken',
  programm: '/kontrollen',
  ueberwachung: '/feststellungen',
};

const OFFEN_ANZEIGE = new Set(['FAELLIG', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN', 'GEPLANT']);

/**
 * Anzeige-Auswahl „Fällige Kontrollen“: überfällig oder zur Gegenzeichnung
 * immer, sonst offene Durchführungen der nächsten 14 Tage. Den Status jeder
 * Durchführung (`anzeige`) berechnet der Dienst; hier wird nur gefiltert und
 * sortiert.
 */
export function faelligeDurchfuehrungen(ctx: KontextAntwort): Durchfuehrung[] {
  const prio = (d: Durchfuehrung) =>
    d.anzeige === 'UEBERFAELLIG' ? 0 : d.anzeige === 'ZUR_GEGENZEICHNUNG' ? 2 : 1;
  return ctx.durchfuehrungen
    .filter(
      (d) =>
        d.anzeige === 'UEBERFAELLIG' ||
        d.anzeige === 'ZUR_GEGENZEICHNUNG' ||
        (OFFEN_ANZEIGE.has(d.anzeige) && (isoTageZwischen(ctx.stand, d.faelligAm) ?? 99) <= 14),
    )
    .sort(
      (a, b) =>
        prio(a) - prio(b) ||
        (alsDatum(a.faelligAm)?.getTime() ?? 0) - (alsDatum(b.faelligAm)?.getTime() ?? 0),
    );
}

/** Mandant noch nicht im Tax-CMS angelegt (kontextLesen → 404). */
export function NichtAngelegt({ seite }: { seite: TcmsMandantSeite }) {
  return (
    <div className="card">
      <TcmsLeer
        icon={ShieldCheck}
        text="Dieser Mandant ist im Tax-CMS noch nicht angelegt. Name, Rechtsform und DATEV-Nummer werden aus der Mandantenakte übernommen."
      >
        <MandantAnlegenFormular
          mandantId={seite.mandantId}
          beschriftung="Mandant im Tax-CMS anlegen"
          erfolg="Der Mandant ist im Tax-CMS angelegt. Als Nächstes richten Sie das Tax-CMS ein."
        />
      </TcmsLeer>
      <p className="card-footer justify-center">
        <span>
          Danach geht es weiter unter{' '}
          <Link href={`${seite.basis}/einrichtung`} className="underline">
            Einrichtung
          </Link>
          . Ob Sie den Mandanten anlegen dürfen, prüft das Tax-CMS.
        </span>
      </p>
    </div>
  );
}

function OhneProgramm({ seite, ctx }: { seite: TcmsMandantSeite; ctx: KontextAntwort }) {
  const entwurf = ctx.programm !== null;
  const text = entwurf
    ? 'Die Einrichtung des Tax-CMS läuft. Version 1 ist noch nicht angelegt.'
    : 'Für diesen Mandanten ist noch kein Tax-CMS eingerichtet.';
  const beschriftung = entwurf ? 'Einrichtung fortsetzen' : 'Tax-CMS einrichten';
  return (
    <div className="card">
      <TcmsLeer icon={ShieldCheck} text={text}>
        {ctx.rechte.bearbeiten ? (
          <Link className="btn-primary" href={`${seite.basis}/einrichtung`}>
            <ArrowRight className="h-4 w-4" aria-hidden="true" /> {beschriftung}
          </Link>
        ) : (
          <span className="text-sm text-muted">{TCMS_KEIN_RECHT.BEARBEITEN}</span>
        )}
      </TcmsLeer>
    </div>
  );
}

/** Untertitel der Phasen (Anzeige; Phase und Gates kommen aus dem Dienst). */
function phasenUnterzeilen(ctx: KontextAntwort): Record<number, string> {
  const p = ctx.programm!;
  const zeilen: Record<number, string> = {};
  const freigegeben = ctx.beschreibungen.filter((b) => b.freigegebenAm).at(-1);
  if (freigegeben) zeilen[4] = `v${freigegeben.nummer} freigegeben`;
  if (p.angemessenheitStichtag) {
    zeilen[5] =
      p.angemessenheitStichtag.slice(0, 10) > ctx.stand
        ? `Stichtag geplant ${isoDatumText(p.angemessenheitStichtag)}`
        : `Stichtag ${isoDatumText(p.angemessenheitStichtag)}`;
  }
  if (ctx.zeitraum && p.wirksamAb) {
    zeilen[6] =
      ctx.aktivePhase === 6
        ? `Monat ${ctx.zeitraum.monat} von ${ctx.zeitraum.monate}`
        : `${isoDatumKurzText(p.wirksamAb)}–${isoDatumText(p.wirksamBis)}`;
  }
  const aktiv = ctx.phasen.find((x) => x.nr === ctx.aktivePhase);
  if (aktiv && !zeilen[aktiv.nr]) {
    zeilen[aktiv.nr] =
      `Gate: ${aktiv.bedingungen.filter((b) => b.erfuellt).length} von ${aktiv.bedingungen.length}`;
  }
  for (const x of ctx.phasen) if (x.nr > ctx.aktivePhase && !zeilen[x.nr]) zeilen[x.nr] = '';
  return zeilen;
}

/** Gemeinsame Angaben der Karten: Antwort, Linkbasis und Stichtag-Erhalt. */
interface KartenKontext {
  ctx: KontextAntwort;
  basis: string;
  mitStand: (href: string) => string;
}

export function Cockpit({
  seite,
  ctx,
  faellige,
  namen,
}: {
  seite: TcmsMandantSeite;
  ctx: KontextAntwort;
  faellige: Durchfuehrung[];
  namen: TcmsNamen;
}) {
  const stammdatenAbweichend = ctx.mandant.name !== ankerName(seite.mandant.name);
  if (!ctx.programm || (ctx.programm.status === 'ENTWURF' && !ctx.programm.version1Am)) {
    return (
      <>
        {stammdatenAbweichend ? <StammdatenHinweis seite={seite} ctx={ctx} /> : null}
        <OhneProgramm seite={seite} ctx={ctx} />
      </>
    );
  }
  const k: KartenKontext = {
    ctx,
    basis: seite.basis,
    mitStand: (href) =>
      ctx.historisch ? `${href}${href.includes('?') ? '&' : '?'}stand=${ctx.stand}` : href,
  };
  return (
    <>
      <TcmsKopf
        daten={{
          teilbereich: ctx.teilbereich,
          aktivePhase: ctx.aktivePhase,
          historisch: ctx.historisch,
          stand: ctx.stand,
          heute: ctx.heute,
          ausgeblendet: ctx.ausgeblendet,
        }}
        titel={<h2 className="text-lg font-semibold text-primary mr-2">Cockpit</h2>}
      />
      {stammdatenAbweichend ? <StammdatenHinweis seite={seite} ctx={ctx} /> : null}
      <TcmsPflichthinweis />
      <P153Hinweis k={k} />
      <div className="card mt-4 px-6 py-5">
        <PhasenStepper
          phasen={ctx.phasen}
          aktiv={ctx.aktivePhase}
          unterzeilen={phasenUnterzeilen(ctx)}
        />
      </div>
      <GateDetails k={k} />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mt-4">
        <GrundelementeKarte k={k} />
        <RisikenKarte k={k} />
        <ZeitraumKarte k={k} />
        <FaelligKarte k={k} faellige={faellige} namen={namen} />
        <FeststellungenKarte k={k} />
        <EreignisseKarte k={k} namen={namen} />
        <LaenderKarte k={k} />
      </div>
      <p className="text-xs text-muted mt-6">
        Frequenzen folgen aus Governance-Typ × Bruttoklasse (Startwerte, vom Berufsträger zu
        kalibrieren). Statusangaben sind Betriebsinformationen, keine Aussage über Angemessenheit
        oder Wirksamkeit. Erklärungsturnus:{' '}
        {frequenzLabel({ turnus: ctx.programm.erklaerungsTurnus, anlass: false })}.
      </p>
    </>
  );
}

/** Offene §-153-Würdigungen; maskierte vertrauliche Feststellungen tragen keine (RT-01). */
function P153Hinweis({ k }: { k: KartenKontext }) {
  const p153 = k.ctx.feststellungen.flatMap((f) => (!f.maskiert && f.p153Offen ? [f] : []));
  if (p153.length === 0) return null;
  return (
    <div
      className="alert-error mt-3 flex flex-wrap items-center justify-between gap-2"
      role="alert"
    >
      <span className="inline-flex items-center gap-2">
        <TriangleAlert className="h-4 w-4" aria-hidden="true" />
        <span>
          <strong>§-153-Würdigung offen</strong> –{' '}
          {p153.map((f, i) => (
            <Fragment key={f.id}>
              {i > 0 ? ', ' : null}
              {f.nummer} (<TcmsText>{f.titel}</TcmsText>)
            </Fragment>
          ))}
          .
        </span>
      </span>
      <Link
        href={k.mitStand(`${k.basis}/feststellungen/${encodeURIComponent(p153[0]!.id)}`)}
        className="btn-secondary text-xs py-1"
      >
        Zur Würdigung
      </Link>
    </div>
  );
}

function GateDetails({ k }: { k: KartenKontext }) {
  const aktiv = k.ctx.phasen.find((p) => p.nr === k.ctx.aktivePhase);
  if (!aktiv || aktiv.bedingungen.length === 0) return null;
  return (
    <details className="details-box mt-3">
      <summary>
        <ChevronRight className="h-4 w-4" aria-hidden="true" /> Gate der aktiven Phase ·{' '}
        {aktiv.bedingungen.filter((b) => b.erfuellt).length} von {aktiv.bedingungen.length}{' '}
        Bedingungen erfüllt
      </summary>
      <ul className="details-body flex flex-wrap gap-x-5 gap-y-2">
        {aktiv.bedingungen.map((b) => (
          <li key={b.text} className="inline-flex items-center gap-1.5 text-sm">
            {b.erfuellt ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-700" aria-hidden="true" />
            ) : (
              <Circle className="h-4 w-4 text-muted" aria-hidden="true" />
            )}
            <span className="sr-only">{b.erfuellt ? 'erfüllt: ' : 'offen: '}</span>
            {b.link && !b.erfuellt ? (
              <Link className="underline" href={k.mitStand(`${k.basis}/${b.link}`)}>
                <TcmsText>{b.text}</TcmsText>
              </Link>
            ) : (
              <span className={b.erfuellt ? 'text-primary' : 'text-muted'}>
                <TcmsText>{b.text}</TcmsText>
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Kopf einer Karte mit Überschrift (h3) und optionalem Element rechts. */
function KartenKopf({ id, titel, children }: { id: string; titel: string; children?: ReactNode }) {
  return (
    <div className="card-header">
      <h3 id={id} className="text-sm font-semibold text-primary">
        {titel}
      </h3>
      {children}
    </div>
  );
}

function GrundelementeKarte({ k }: { k: KartenKontext }) {
  return (
    <section className="card" aria-labelledby="tcms-grundelemente">
      <KartenKopf id="tcms-grundelemente" titel="Sieben Grundelemente" />
      <ul>
        {k.ctx.grundelemente.map((g) => (
          <li key={g.key} className="border-b border-default last:border-b-0">
            <Link
              href={k.mitStand(`${k.basis}${GRUNDELEMENT_ZIEL[g.key] ?? '/beschreibung'}`)}
              className="flex items-center gap-3 px-6 py-2.5 hover:bg-surface-raised"
              title={g.luecken.join('\n') || 'dokumentiert'}
            >
              <span className={`kpi-chip ${g.luecken.length ? 'chip-amber' : 'chip-green'}`}>
                <KatalogIcon name={g.icon} />
              </span>
              <span className="text-sm grow text-primary">
                <TcmsText>{g.titel}</TcmsText>
              </span>
              {g.luecken.length ? (
                <span className="badge-yellow">Lücken ({g.luecken.length})</span>
              ) : (
                <span className="text-xs text-muted">dokumentiert</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RisikenKarte({ k }: { k: KartenKontext }) {
  const { ctx } = k;
  const ueberAppetit = ctx.risiken.filter((r) => r.ueberAppetit).length;
  const last = ctx.prueflast[1] ?? ctx.prueflast[0];
  const lastMonat = last
    ? `${MONATE[Number(last.monat.slice(5, 7)) - 1] ?? ''} ${last.monat.slice(0, 4)}`
    : '';
  return (
    <section className="card xl:col-span-2" aria-labelledby="tcms-risiken">
      <KartenKopf id="tcms-risiken" titel={`Risiken – ${ctx.risiken.length} aktiv`}>
        {ueberAppetit > 0 ? (
          <Link href={k.mitStand(`${k.basis}/risiken?appetit=1`)} className="badge-red">
            {ueberAppetit} über Appetit
          </Link>
        ) : (
          <span className="badge-green">kein Risiko über Appetit</span>
        )}
      </KartenKopf>
      <div className="p-6">
        <RisikoHeatmap
          ziel={`${k.basis}/risiken`}
          stand={ctx.historisch ? ctx.stand : null}
          risiken={ctx.risiken.map((r) => ({
            code: r.code,
            s: r.s,
            w: r.w,
            brutto: r.bewertung.brutto.klasse,
            design: r.bewertung.wirksamDesign,
            betrieb: r.bewertung.wirksamBetrieb,
          }))}
        />
      </div>
      {last ? (
        <div className="border-t border-default px-6 py-4">
          <p className="text-xs font-semibold text-secondary mb-2">
            Manuelle Prüflast · {lastMonat} (Prognose aus geplanten Durchführungen)
          </p>
          <BalkenZeilen
            label={`Prüflast ${lastMonat}`}
            zeilen={[
              { label: 'FP · periodisch', wert: last.FP },
              { label: 'FF · laufend', wert: last.FF, fuellung: 'gelb' },
              { label: 'IN · Aufklärung', wert: last.IN, fuellung: 'grau' },
              ...(last.ausloesungen ? [{ label: 'Auslösungen', wert: last.ausloesungen }] : []),
            ]}
          />
        </div>
      ) : null}
    </section>
  );
}

function zeitraumText(ctx: KontextAntwort): string {
  const zr = ctx.zeitraum;
  const p = ctx.programm;
  if (!zr || !p) return 'nicht festgelegt';
  if (zr.monat === 0 && p.wirksamAb) return `beginnt ${isoDatumText(p.wirksamAb)}`;
  if (p.wirksamBis && ctx.stand > p.wirksamBis.slice(0, 10)) {
    return `abgeschlossen · ${zr.monate} Monate`;
  }
  return `Monat ${zr.monat} von ${zr.monate}`;
}

function ZeitraumKarte({ k }: { k: KartenKontext }) {
  const zr = k.ctx.zeitraum;
  const p = k.ctx.programm;
  return (
    <section className="card" aria-labelledby="tcms-zeitraum">
      <KartenKopf id="tcms-zeitraum" titel="Wirksamkeitszeitraum">
        <span className="badge-gray">{zeitraumText(k.ctx)}</span>
      </KartenKopf>
      {zr && p?.wirksamAb && p.wirksamBis ? (
        <div className="p-6 space-y-4">
          <p className="text-sm text-secondary">
            {isoDatumKurzText(p.wirksamAb)} – {isoDatumText(p.wirksamBis)}
          </p>
          <Fortschritt
            anteil={zr.monate > 0 ? zr.monat / zr.monate : 0}
            label={`Monat ${zr.monat} von ${zr.monate}`}
          />
          <SegmentBalken
            label="Durchführungen im Zeitraum"
            teile={[
              { label: 'ohne Befund', wert: zr.ohneBefund, fuellung: 'gruen' },
              { label: 'mit Befund', wert: zr.mitBefund, fuellung: 'gelb' },
              { label: 'offen', wert: zr.offen, fuellung: 'brand' },
            ]}
          />
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary">
            <li>{zr.ohneGegenzeichnung} ohne Gegenzeichnung</li>
            <li>{zr.ueberfaellig} überfällig</li>
            <li>{zr.fehlendeNachweise} fehlende Nachweise</li>
          </ul>
        </div>
      ) : (
        <p className="p-6 text-sm text-muted">
          Der Wirksamkeitszeitraum beginnt nach dokumentierter Angemessenheit (Phase 5).
        </p>
      )}
    </section>
  );
}

function FaelligKarte({
  k,
  faellige,
  namen,
}: {
  k: KartenKontext;
  faellige: Durchfuehrung[];
  namen: TcmsNamen;
}) {
  return (
    <section className="card xl:col-span-2" aria-labelledby="tcms-faellig">
      <KartenKopf id="tcms-faellig" titel="Fällige Kontrollen">
        <Link href={k.mitStand(`${k.basis}/kontrollen`)} className="text-xs text-muted">
          Kontrollmatrix →
        </Link>
      </KartenKopf>
      {faellige.length === 0 ? (
        <TcmsLeer icon={CheckCheck} text="In den nächsten 14 Tagen ist nichts fällig." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th">Kontrolle</th>
                <th className="th">Periode</th>
                <th className="th">Fälligkeit</th>
                <th className="th">Partei</th>
                <th className="th">Status</th>
                <th className="th th-right">Zuständig</th>
              </tr>
            </thead>
            <tbody>
              {faellige.slice(0, 8).map((d) => (
                <FaelligZeile key={d.id} k={k} d={d} namen={namen} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-footer">
        <span>
          {k.ctx.zeitraum?.ohneGegenzeichnung ?? 0} Durchführungen warten auf Gegenzeichnung.
        </span>
        <span>{faellige.length > 8 ? `${faellige.length - 8} weitere` : ''}</span>
      </div>
    </section>
  );
}

function FaelligZeile({ k, d, namen }: { k: KartenKontext; d: Durchfuehrung; namen: TcmsNamen }) {
  const tage = isoTageZwischen(k.ctx.stand, d.faelligAm);
  return (
    <tr className="border-t border-default">
      <td className="px-6 py-2">
        <Link
          href={k.mitStand(`${k.basis}/durchfuehrungen/${encodeURIComponent(d.id)}`)}
          className="font-medium text-primary hover:underline"
        >
          {d.code} · <TcmsText>{d.titel}</TcmsText>
        </Link>
      </td>
      <td className="px-6 py-2 text-secondary">
        <TcmsText>{d.periodeLabel}</TcmsText>
      </td>
      <td className="px-6 py-2">
        <span className={d.anzeige === 'UEBERFAELLIG' ? 'text-red-700' : undefined}>
          {isoDatumText(d.faelligAm)}
          {tage !== null ? ` · ${relativTage(tage)}` : ''}
        </span>
      </td>
      <td className="px-6 py-2">
        <span className="badge-gray">{PARTEI_LABEL[d.partei]}</span>
      </td>
      <td className="px-6 py-2">
        <AnzeigeBadge status={d.anzeige} />
      </td>
      <td className="px-6 py-2 text-right text-xs text-muted">
        {namen.name(d.anzeige === 'ZUR_GEGENZEICHNUNG' ? d.gegenzeichnerId : d.durchfuehrendId)}
      </td>
    </tr>
  );
}

type Feststellung = KontextAntwort['feststellungen'][number];

function feststellungUnterzeile(f: Feststellung): ReactNode {
  if (f.maskiert) return `${FESTSTELLUNG_STATUS_LABEL[f.status]} · ${VERTRAULICH_HINWEIS}`;
  const p153 = f.p153Offen
    ? '§-153-Würdigung offen'
    : f.p153Entscheidung
      ? `entschieden: ${P153_LABEL[f.p153Entscheidung]}`
      : 'ohne §-153-Bezug';
  return (
    <>
      {KLASSE_LABEL[f.schwere]} · {p153} · Quelle <TcmsText>{f.quelleText}</TcmsText>
    </>
  );
}

function feststellungChip(f: Feststellung): string {
  if (f.maskiert) return 'chip-gray';
  return f.schwere === 'HOCH' || f.schwere === 'KRITISCH' ? 'chip-red' : 'chip-amber';
}

function FeststellungenKarte({ k }: { k: KartenKontext }) {
  const offen = k.ctx.feststellungen.filter(
    (f) => f.status !== 'GESCHLOSSEN' && f.status !== 'VERWORFEN',
  );
  return (
    <section className="card" aria-labelledby="tcms-feststellungen">
      <KartenKopf id="tcms-feststellungen" titel="Offene Feststellungen">
        <Link href={k.mitStand(`${k.basis}/feststellungen`)} className="badge-gray">
          {offen.length}
        </Link>
      </KartenKopf>
      {offen.length === 0 ? (
        <TcmsLeer icon={CheckCheck} text="Keine offenen Feststellungen." />
      ) : (
        <ul>
          {offen.map((f) => (
            <li key={f.id} className="border-b border-default last:border-b-0">
              <Link
                href={k.mitStand(`${k.basis}/feststellungen/${encodeURIComponent(f.id)}`)}
                className="flex items-start gap-3 px-6 py-3 hover:bg-surface-raised"
              >
                <span className={`kpi-chip ${feststellungChip(f)}`}>
                  {f.maskiert ? (
                    <Lock className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <TriangleAlert className="h-4 w-4" aria-hidden="true" />
                  )}
                </span>
                <span className="grow">
                  <span className="block text-sm font-medium text-primary">
                    <FeststellungBezeichnung f={f} />
                  </span>
                  <span className="block text-xs text-muted mt-0.5">
                    {feststellungUnterzeile(f)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EreignisseKarte({ k, namen }: { k: KartenKontext; namen: TcmsNamen }) {
  const neu = k.ctx.ereignisse.filter((e) => e.status === 'NEU');
  return (
    <section className="card" aria-labelledby="tcms-ereignisse">
      <KartenKopf id="tcms-ereignisse" titel="Ereigniseingang">
        <Link
          href={k.mitStand(`${k.basis}/ereignisse`)}
          className={neu.length ? 'badge-yellow' : 'badge-gray'}
        >
          {neu.length} ungetriagiert
        </Link>
      </KartenKopf>
      {neu.length === 0 ? (
        <TcmsLeer icon={Inbox} text="Keine ungetriagierten Ereignisse." />
      ) : (
        <ul>
          {neu.map((e) => {
            const typ = ereignistyp(e.typ);
            return (
              <li key={e.id} className="border-b border-default last:border-b-0">
                <Link
                  href={k.mitStand(`${k.basis}/ereignisse?e=${encodeURIComponent(e.id)}`)}
                  className="flex items-start gap-3 px-6 py-3 hover:bg-surface-raised"
                >
                  <span className={`kpi-chip ${tonChip(typ?.ton)}`}>
                    <KatalogIcon name={typ?.icon ?? 'Bell'} />
                  </span>
                  <span className="grow">
                    <span className="block text-sm font-medium text-primary">
                      {e.typ} · <TcmsText>{e.titel}</TcmsText>
                    </span>
                    <span className="block text-xs text-muted mt-0.5">
                      {EREIGNIS_QUELLE_LABEL[e.quelle]} · {namen.name(e.gemeldetVon)} ·{' '}
                      {isoDatumText(e.gemeldetAm)}
                    </span>
                  </span>
                  <span className="badge-brand">neu</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const SCHWELLE_BADGE = {
  UEBERSCHRITTEN: 'badge-red',
  WARNUNG: 'badge-yellow',
  UNTERSCHRITTEN: 'badge-green',
} as const;

function LaenderKarte({ k }: { k: KartenKontext }) {
  const { ctx } = k;
  const fehlt = ctx.laender.filter((l) => l.registrierung === 'FEHLT');
  return (
    <section className="card" aria-labelledby="tcms-laender">
      <KartenKopf id="tcms-laender" titel="Länder-Kurzblick">
        <Link href={k.mitStand(`${k.basis}/laender`)} className="text-xs text-muted">
          Alle {ctx.laender.length} Länder →
        </Link>
      </KartenKopf>
      <div className="p-6 space-y-2">
        <p className="text-xs font-semibold text-secondary">
          EU-Fernverkäufe laufendes Jahr
          {ctx.laenderStand
            ? ` (${ctx.laenderQuelle === 'CSV' ? 'CSV-Import' : 'manuell erfasst'}, Stand ${isoDatumText(ctx.laenderStand)})`
            : ''}
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-lg font-bold font-mono text-primary">
            {fmtEurGanz(ctx.fernverkaeufeLfd)}
          </span>
          <span className={SCHWELLE_BADGE[ctx.schwelle.status]}>
            <TcmsText>{ctx.schwelle.label}</TcmsText>
          </span>
        </div>
        <SchwellenAnzeige
          anteil={Math.max(ctx.schwelle.anteilLfd, ctx.schwelle.anteilVorjahr)}
          label="Anteil an der EU-Lieferschwelle"
        />
      </div>
      <ul className="border-t border-default">
        <li className="flex items-center justify-between px-6 py-2 text-sm">
          <span>{ctx.laender.length} Länder im Monitor</span>
          <span className="text-xs text-muted">
            {ctx.laender.filter((l) => l.registrierung === 'VOLLSTAENDIG').length} vollständig
          </span>
        </li>
        {fehlt.map((l) => (
          <li key={l.id} className="border-t border-default">
            <Link
              href={k.mitStand(`${k.basis}/laender`)}
              className="flex items-center justify-between px-6 py-2 text-sm hover:bg-surface-raised"
            >
              <span>{LAND_NAME[l.land] ?? l.land}</span>
              <span className="badge-red">Registrierung fehlt</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Name im Tax-CMS weicht von der Mandantenakte ab: Abgleich anbieten. */
/**
 * Stammdaten im Tax-CMS weichen von der Mandantenakte ab. Übernehmen nur mit
 * dem Kennzeichen des Dienstes (`mandant.rechte.bearbeiten`; im historischen
 * Stand immer `false`), sonst der feste Grund statt der Schaltfläche.
 */
function StammdatenHinweis({ seite, ctx }: { seite: TcmsMandantSeite; ctx: KontextAntwort }) {
  return (
    <div
      className="alert-info mb-3 flex flex-wrap items-center justify-between gap-3"
      role="status"
    >
      <span>Die Stammdaten im Tax-CMS weichen von der Mandantenakte ab.</span>
      {ctx.mandant.rechte.bearbeiten ? (
        <MandantAnlegenFormular
          mandantId={seite.mandantId}
          beschriftung="Stammdaten übernehmen"
          erfolg="Die Stammdaten sind im Tax-CMS aktualisiert."
        />
      ) : (
        <span className="text-sm text-muted">
          {ctx.historisch
            ? 'Übernehmen ist nur im aktuellen Stand möglich.'
            : TCMS_KEIN_RECHT.BEARBEITEN}
        </span>
      )}
    </div>
  );
}
