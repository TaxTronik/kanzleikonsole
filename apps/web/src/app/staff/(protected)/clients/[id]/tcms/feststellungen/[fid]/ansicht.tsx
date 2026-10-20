// =============================================================================
// Darstellung einer Feststellung (TCMS Stufe 3, Bereich C). Anzeige der
// Antwort von `feststellungLesen`; Bedienelemente sperrt die Seite nur
// sichtbar nach den Kennzeichen des Kontexts (`rechte.bearbeiten`,
// `rechte.wuerdigen`), dem Stichtag und – beim Verwerfen – dem Vier-Augen-
// Prinzip (wer beantragt hat, entscheidet nicht). Entscheidend ist der Dienst.
// Der nächste Schritt ist eine Vorschau aus @taxtronik/tcms-domain.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, CalendarClock, EyeOff, Info } from 'lucide-react';
import type { FeststellungDetailSchema, KontextAntwort } from '@taxtronik/tcms-contract';
import {
  ANZEIGE_LABEL,
  AUSWIRKUNG_BADGE,
  AUSWIRKUNG_LABEL,
  FESTSTELLUNG_KLASSE_LABEL,
  FESTSTELLUNG_STATUS_LABEL,
  fmtEur,
  naechsterFeststellungsschritt,
  p153Erforderlich,
  QUELLE_LABEL,
  relativTage,
  type FeststellungStatus,
} from '@taxtronik/tcms-domain';
import type { z } from 'zod';
import { AnzeigeBadge, GtBadge, KlasseBadge, VertraulichBadge } from '@/components/tcms/badges';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import {
  AktionsKnopf,
  type TcmsErgebnis,
  type TcmsFormAktion,
} from '@/components/tcms/durchfuehrung/formulare';
import { FeststellungBezeichnung } from '@/components/tcms/feststellung';
import {
  ErklaerungDialog,
  ErledigenDialog,
  MassnahmeDialog,
  NachkontrolleDialog,
  P153Block,
  VerwerfenDialog,
  VertraulichSchalter,
  WuerdigungDialog,
} from '@/components/tcms/feststellungen/formulare';
import {
  FeststellungStatusBadge,
  FeststellungStepper,
  kontrollCode,
  p153Abschliessend,
  p153Label,
  p153OptionTitel,
  P153_ERLAEUTERUNG,
  P153_OPTIONEN,
} from '@/components/tcms/feststellungen/teile';
import {
  alsDatum,
  isoDatumKurzText,
  isoDatumText,
  isoTageZwischen,
  isoZeitText,
} from '@/components/tcms/format';
import { TcmsKopf, type TcmsKopfDaten } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import { badgeKlasse } from '@/components/tcms/ton';
import type { TcmsNamen } from '@/server/tcms/namen';
import type { TcmsMandantSeite } from '@/server/tcms/seite';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import {
  erklaerungAction,
  feststellungWeiterAction,
  massnahmeAnlegenAction,
  massnahmeErledigenAction,
  nachkontrolleAction,
  p153EntscheidenAction,
  verwerfenAblehnenAction,
  verwerfenBeantragenAction,
  verwerfenBestaetigenAction,
  vertraulichAction,
  wuerdigungAction,
} from '../actions';
import { TCMS_TEXT_ISOLIERT, TcmsText } from '@/components/tcms/text';

type Detail = z.output<typeof FeststellungDetailSchema>;
type Lesbar = Extract<Detail, { maskiert: false }>;
type Maskiert = Extract<Detail, { maskiert: true }>;
type GebundeneAktion = (
  mandantId: string,
  id: string,
  vorher: TcmsErgebnis | null,
  formData: FormData,
) => Promise<TcmsErgebnis>;

const NUR_AKTUELL = 'Änderungen nur im aktuellen Stand möglich';
const GESCHLOSSEN = 'Feststellung ist geschlossen oder verworfen';

function kopfDaten(ctx: KontextAntwort): TcmsKopfDaten {
  return {
    teilbereich: ctx.teilbereich,
    aktivePhase: ctx.programm ? ctx.aktivePhase : null,
    historisch: ctx.historisch,
    stand: ctx.stand,
    heute: ctx.heute,
    ausgeblendet: ctx.ausgeblendet,
  };
}

function Zurueck({ href }: { href: string }) {
  return (
    <Link href={href} className="back-link">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Zur Feststellungsliste
    </Link>
  );
}

function mitStandFuer(ctx: KontextAntwort) {
  return (href: string) =>
    ctx.historisch ? `${href}${href.includes('?') ? '&' : '?'}stand=${ctx.stand}` : href;
}

/** Vertrauliche Feststellung, Person nicht beteiligt: nur die Nummer (RT-01). */
export function MaskierteFeststellung({
  seite,
  f,
  ctx,
}: {
  seite: TcmsMandantSeite;
  f: Maskiert;
  ctx: KontextAntwort;
}) {
  return (
    <>
      <TcmsKopf
        daten={kopfDaten(ctx)}
        titel={
          <h2 className="text-lg font-semibold text-primary mr-2">
            <FeststellungBezeichnung f={f} />
          </h2>
        }
      />
      <Zurueck href={mitStandFuer(ctx)(`${seite.basis}/feststellungen`)} />
      <div className="card">
        <TcmsLeer
          icon={EyeOff}
          text={`${f.nummer} ist als vertraulich markiert. Inhalt und Verlauf sind nur für Beteiligte sichtbar (zuständige Berufsträger:innen, Hauptbearbeitung, erfassende und verantwortliche Personen).`}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Lage
// ---------------------------------------------------------------------------

interface Lage {
  f: Lesbar;
  ctx: KontextAntwort;
  namen: TcmsNamen;
  basis: string;
  mandantId: string;
  nutzerId: string;
  offen: boolean;
  /** Sperrgrund für Bearbeiten (Stichtag, Recht, Status) oder null. */
  sperre: string | null;
  /** Sperrgrund für die §-153-Würdigung oder null. */
  p153Sperre: string | null;
  heute: string;
  plus14: string;
  mitStand: (href: string) => string;
  binden: (a: GebundeneAktion, id?: string) => TcmsFormAktion;
}

function plusTage(iso: string, tage: number): string {
  const d = alsDatum(iso) ?? new Date();
  return new Date(d.getTime() + tage * 86_400_000).toISOString().slice(0, 10);
}

function lageAus(seite: TcmsMandantSeite, f: Lesbar, ctx: KontextAntwort, namen: TcmsNamen): Lage {
  const offen = f.status !== 'GESCHLOSSEN' && f.status !== 'VERWORFEN';
  const sperreBasis = ctx.historisch ? NUR_AKTUELL : null;
  return {
    f,
    ctx,
    namen,
    basis: seite.basis,
    mandantId: seite.mandantId,
    nutzerId: seite.session.user.staffId,
    offen,
    sperre:
      sperreBasis ??
      (!ctx.rechte.bearbeiten ? TCMS_KEIN_RECHT.BEARBEITEN : offen ? null : GESCHLOSSEN),
    p153Sperre:
      sperreBasis ??
      (!ctx.rechte.wuerdigen ? TCMS_KEIN_RECHT.WUERDIGEN : offen ? null : GESCHLOSSEN),
    heute: ctx.heute,
    plus14: plusTage(ctx.heute, 14),
    mitStand: mitStandFuer(ctx),
    binden: (a, id = f.id) => a.bind(null, seite.mandantId, id),
  };
}

export function FeststellungAnsicht({
  seite,
  f,
  ctx,
  namen,
  personen,
}: {
  seite: TcmsMandantSeite;
  f: Lesbar;
  ctx: KontextAntwort;
  namen: TcmsNamen;
  personen: ReadonlyArray<readonly [string, string]>;
}) {
  const l = lageAus(seite, f, ctx, namen);
  return (
    <>
      <TcmsKopf daten={kopfDaten(ctx)} />
      <Zurueck href={l.mitStand(`${l.basis}/feststellungen`)} />
      <Kopf l={l} />
      <TcmsPflichthinweis />
      <StatusKarte l={l} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-8">
          <Sachverhalt l={l} />
          <RisikenKontrollen l={l} />
          <Erklaerungen l={l} />
          <Massnahmen l={l} personen={personen} />
          <P153Karte l={l} />
          <Nachkontrolle l={l} />
        </div>
        <div className="flex flex-col gap-4 xl:col-span-4">
          <Erfassung l={l} />
          <Verlauf l={l} />
          <WeitereAktionen l={l} />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Kopf und Status
// ---------------------------------------------------------------------------

function Kopf({ l }: { l: Lage }) {
  const { f, namen } = l;
  return (
    <>
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-primary mr-1">
            <FeststellungBezeichnung f={f} />
          </h2>
          <KlasseBadge klasse={f.schwere} title="Schwere" />
          {f.vertraulich ? <VertraulichBadge /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={badgeKlasse(AUSWIRKUNG_BADGE[f.auswirkung])}>
            steuerliche Auswirkung: {AUSWIRKUNG_LABEL[f.auswirkung]}
          </span>
          <span className="badge-gray">{FESTSTELLUNG_KLASSE_LABEL[f.klasse]}</span>
          <FeststellungStatusBadge status={f.status} />
        </div>
      </div>
      {f.status === 'VERWORFEN' ? (
        <div className="alert-warning mb-3" role="status">
          <strong>Verworfen.</strong> <TcmsText>{f.verwerfen?.begruendung ?? ''}</TcmsText>
          {f.verwerfen ? (
            <span className="text-xs">
              {' '}
              — beantragt von {namen.name(f.verwerfen.beantragtVon)}, bestätigt von{' '}
              {namen.name(f.verwerfen.bestaetigtVon)}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function unterzeilen(l: Lage): Partial<Record<FeststellungStatus, string>> {
  const { f, namen } = l;
  const offenM = f.massnahmen.filter((m) => m.status === 'OFFEN').length;
  const fertig = p153Abschliessend(f.p153?.entscheidung);
  let wuerdigung = '§-153-Entscheidung offen';
  if (!p153Erforderlich(f.auswirkung)) wuerdigung = 'kein §-153-Pfad';
  else if (f.p153 && fertig) wuerdigung = `§ 153: entschieden ${isoDatumKurzText(f.p153.am)}`;
  else if (f.p153) wuerdigung = `Klärung bis ${isoDatumKurzText(f.p153.frist)}`;
  let massnahmen = 'keine angelegt';
  if (f.massnahmen.length && offenM) {
    massnahmen = `${f.massnahmen.length} angelegt · ${offenM} offen`;
  } else if (f.massnahmen.length) massnahmen = `${f.massnahmen.length} erledigt`;
  return {
    ERFASST: `${isoDatumText(f.erfasstAm)} · ${namen.name(f.erfasstVon)}`,
    IN_WUERDIGUNG: wuerdigung,
    MASSNAHMEN_OFFEN: massnahmen,
    NACHKONTROLLE: f.nachkontrolle
      ? `${f.nachkontrolle.code} · ${ANZEIGE_LABEL[f.nachkontrolle.anzeige]}`
      : '—',
    GESCHLOSSEN: f.geschlossenAm ? isoDatumText(f.geschlossenAm) : '—',
  };
}

function StatusKarte({ l }: { l: Lage }) {
  const { f } = l;
  // Vorschau aus der Domain; ob weitergeschaltet wird, entscheidet der Dienst.
  const schritt = naechsterFeststellungsschritt({
    status: f.status,
    auswirkung: f.auswirkung,
    p153Entschieden: p153Abschliessend(f.p153?.entscheidung),
    massnahmen: f.massnahmen.length,
    massnahmenOffen: f.massnahmen.filter((m) => m.status === 'OFFEN').length,
    nachkontrolleOhneBefund: f.nachkontrolle?.anzeige === 'OHNE_BEFUND',
  });
  const grund = l.sperre ?? (schritt.blockiert ? `Noch nicht möglich: ${schritt.blockiert}` : null);
  return (
    <section className="card mt-4 mb-4 px-6 py-5" aria-label="Status der Feststellung">
      <FeststellungStepper status={f.status} unterzeilen={unterzeilen(l)} />
      {schritt.ziel ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-default pt-3">
          <span className="text-sm text-secondary">
            Nächster Schritt: <strong>{FESTSTELLUNG_STATUS_LABEL[schritt.ziel]}</strong>
            {schritt.blockiert ? (
              <span className="text-muted"> — noch nicht möglich: {schritt.blockiert}</span>
            ) : null}
          </span>
          <AktionsKnopf
            action={l.binden(feststellungWeiterAction)}
            felder={{ von: f.status }}
            className="btn-primary text-xs py-1"
            disabled={grund !== null}
            title={grund ?? undefined}
          >
            Weiter zu „{FESTSTELLUNG_STATUS_LABEL[schritt.ziel]}“
          </AktionsKnopf>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Hauptspalte
// ---------------------------------------------------------------------------

function Karte({
  id,
  titel,
  rechts,
  children,
}: {
  id: string;
  titel: string;
  rechts?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-header">
        <h3 id={id} className="text-sm font-semibold text-primary">
          {titel}
        </h3>
        {rechts ? <span className="flex flex-wrap items-center gap-2">{rechts}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Sachverhalt({ l }: { l: Lage }) {
  const { f } = l;
  return (
    <Karte
      id="fs-sachverhalt"
      titel="Sachverhalt"
      rechts={
        f.status === 'ERFASST' || f.status === 'IN_WUERDIGUNG' ? (
          <WuerdigungDialog
            action={l.binden(wuerdigungAction)}
            sperre={l.sperre}
            schwere={f.schwere}
            auswirkung={f.auswirkung}
            auswirkungFest={f.p153 !== null}
            ursache={f.ursache}
          />
        ) : null
      }
    >
      <div className="px-6 py-4 text-sm text-secondary">
        <p className="whitespace-pre-wrap" {...TCMS_TEXT_ISOLIERT}>
          {f.sachverhalt}
        </p>
        <p className="mt-3">
          <span className="text-xs font-semibold">Ursache: </span>
          <span className={f.ursache ? '' : 'text-muted'} {...TCMS_TEXT_ISOLIERT}>
            {f.ursache ?? 'noch nicht erfasst'}
          </span>
        </p>
      </div>
    </Karte>
  );
}

function RisikenKontrollen({ l }: { l: Lage }) {
  const { f, ctx } = l;
  const risiko = (id: string) => l.mitStand(`${l.basis}/risiken?risiko=${encodeURIComponent(id)}`);
  const durchfuehrung = (id: string) =>
    l.mitStand(`${l.basis}/durchfuehrungen/${encodeURIComponent(id)}`);
  const ver01 = ctx.risiken.find((r) => r.code === 'EC-VER-01');
  return (
    <Karte id="fs-risiken" titel="Betroffene Risiken und Kontrollen">
      <div className="flex flex-col gap-2 px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Risiken:</span>
          {f.risiken.length === 0 ? (
            <span className="text-xs text-muted">keine verknüpft</span>
          ) : null}
          {f.risiken.map((r) => {
            const rv = ctx.risiken.find((x) => x.id === r.id);
            return (
              <span key={r.id} className="inline-flex items-center gap-1">
                <Link href={risiko(r.id)} className="badge-gray font-mono" title={rv?.titel}>
                  {r.code}
                </Link>
                {rv ? <KlasseBadge klasse={rv.netto} title="Nettoklasse (wirksam)" /> : null}
                {rv ? <GtBadge gt={rv.gt} /> : null}
              </span>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Verknüpfte Kontrolle:</span>
          {f.durchfuehrung ? (
            <Link
              href={durchfuehrung(f.durchfuehrung.id)}
              className="badge-gray font-mono"
              title={`Durchführung ${f.durchfuehrung.periodeLabel}`}
            >
              {f.durchfuehrung.code}
            </Link>
          ) : (
            <span className="text-xs text-muted">—</span>
          )}
          {f.nachkontrolle ? (
            <>
              <span className="text-xs text-muted">Nachkontrolle:</span>
              <Link href={durchfuehrung(f.nachkontrolle.id)} className="badge-gray font-mono">
                {f.nachkontrolle.code}
              </Link>
            </>
          ) : null}
        </div>
        {f.auswirkung !== 'NEIN' ? (
          <p className="text-xs text-muted">
            jede steuerwirksame Feststellung führt zu{' '}
            {ver01 ? (
              <Link href={risiko(ver01.id)} className="font-mono underline">
                EC-VER-01
              </Link>
            ) : (
              <span className="font-mono">EC-VER-01</span>
            )}
          </p>
        ) : null}
      </div>
    </Karte>
  );
}

function Erklaerungen({ l }: { l: Lage }) {
  const { f } = l;
  const offen = f.erklaerungen.some((e) => e.auswirkungEur == null);
  const summe = f.erklaerungen.reduce((s, e) => s + (e.auswirkungEur ?? 0), 0);
  return (
    <Karte
      id="fs-erklaerungen"
      titel="Betroffene Erklärungen"
      rechts={
        <>
          {f.erklaerungen.length ? (
            offen ? (
              <span className="badge-yellow">Schätzung offen</span>
            ) : (
              <span className="badge-gray">Summe {fmtEur(summe)}</span>
            )
          ) : null}
          {l.offen ? (
            <ErklaerungDialog action={l.binden(erklaerungAction)} sperre={l.sperre} />
          ) : null}
        </>
      }
    >
      {f.erklaerungen.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted">Keine betroffenen Erklärungen erfasst.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th scope="col" className="th">
                Steuerart
              </th>
              <th scope="col" className="th">
                Land
              </th>
              <th scope="col" className="th">
                Zeitraum
              </th>
              <th scope="col" className="th th-right">
                Geschätzte Auswirkung
              </th>
            </tr>
          </thead>
          <tbody>
            {f.erklaerungen.map((e) => (
              <tr key={e.id} className="border-t border-default">
                <td className="px-6 py-2.5" {...TCMS_TEXT_ISOLIERT}>
                  {e.steuerart}
                </td>
                <td className="px-6 py-2.5" {...TCMS_TEXT_ISOLIERT}>
                  {e.land}
                </td>
                <td className="px-6 py-2.5" {...TCMS_TEXT_ISOLIERT}>
                  {e.zeitraum}
                </td>
                <td className={e.auswirkungEur == null ? 'td-num text-muted' : 'td-num'}>
                  {e.auswirkungEur == null ? 'zu klären' : fmtEur(e.auswirkungEur)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Karte>
  );
}

function MassnahmeZeile({ l, m }: { l: Lage; m: Lesbar['massnahmen'][number] }) {
  const { namen } = l;
  const tage = isoTageZwischen(l.ctx.stand, m.frist) ?? 0;
  const ueber = m.status === 'OFFEN' && tage < 0;
  // Anzeige: erledigen darf, wer bearbeiten darf oder verantwortlich ist (Dienst entscheidet).
  const darf = l.ctx.rechte.bearbeiten || l.nutzerId === m.verantwortlich;
  const sperre = l.ctx.historisch
    ? NUR_AKTUELL
    : !l.offen
      ? GESCHLOSSEN
      : darf
        ? null
        : TCMS_KEIN_RECHT.STANDARD;
  return (
    <li className="flex items-start gap-3 px-6 py-3 border-b border-default last:border-b-0">
      <span
        className={`status-dot mt-1.5 ${m.status === 'ERLEDIGT' ? 'dot-green' : ueber ? 'dot-red' : 'dot-amber'}`}
        aria-hidden="true"
      />
      <div className="grow min-w-0">
        <p className="text-sm font-medium text-primary" {...TCMS_TEXT_ISOLIERT}>
          {m.beschreibung}
        </p>
        <p className="text-xs text-muted mt-1">
          Verantwortlich: {namen.name(m.verantwortlich)} · Frist {isoDatumText(m.frist)}
          {m.status === 'OFFEN' ? (
            <span className={ueber ? 'text-red-700' : ''}> ({relativTage(tage)})</span>
          ) : null}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="badge-gray gap-1" title="Wiedervorlage (kanzleiweit)">
            <CalendarClock className="h-3 w-3" aria-hidden="true" /> Wiedervorlage{' '}
            <span className="font-mono">#{m.wiedervorlageNr}</span>
          </span>
          {m.status === 'ERLEDIGT' ? (
            <span className="text-xs text-muted">
              Erledigt · {namen.name(m.erledigtVon)} · {isoZeitText(m.erledigtAm)}
            </span>
          ) : null}
        </div>
        {m.status === 'ERLEDIGT' && m.nachweis ? (
          <p className="text-xs text-secondary mt-1">
            Nachweis: <TcmsText>{m.nachweis}</TcmsText>
          </p>
        ) : null}
      </div>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {m.status === 'ERLEDIGT' ? (
          <span className="badge-green">erledigt</span>
        ) : ueber ? (
          <span className="badge-red">überfällig</span>
        ) : (
          <span className="badge-yellow">offen</span>
        )}
        {m.status === 'OFFEN' ? (
          <ErledigenDialog
            action={l.binden(massnahmeErledigenAction, m.id)}
            nummer={m.wiedervorlageNr}
            beschreibung={m.beschreibung}
            sperre={sperre}
          />
        ) : null}
      </span>
    </li>
  );
}

function Massnahmen({
  l,
  personen,
}: {
  l: Lage;
  personen: ReadonlyArray<readonly [string, string]>;
}) {
  const { f } = l;
  const offen = f.massnahmen.filter((m) => m.status === 'OFFEN').length;
  return (
    <Karte
      id="fs-massnahmen"
      titel="Maßnahmen"
      rechts={
        <>
          {f.massnahmen.length ? (
            offen ? (
              <span className="badge-yellow">{offen} offen</span>
            ) : (
              <span className="badge-green">alle erledigt</span>
            )
          ) : null}
          <MassnahmeDialog
            action={l.binden(massnahmeAnlegenAction)}
            sperre={l.sperre}
            personen={personen}
            heute={l.heute}
            vorschlagFrist={l.plus14}
          />
        </>
      }
    >
      {f.massnahmen.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted">
          Noch keine Maßnahme angelegt. Für „Maßnahmen offen“ ist mindestens eine Maßnahme mit
          Verantwortlichem und Frist nötig.
        </p>
      ) : (
        <ul>
          {f.massnahmen.map((m) => (
            <MassnahmeZeile key={m.id} l={l} m={m} />
          ))}
        </ul>
      )}
    </Karte>
  );
}

function p153Hinweis(l: Lage): string | null {
  if (l.ctx.historisch) return `Historischer Stand zum ${isoDatumText(l.ctx.stand)} – nur Lesen.`;
  if (!l.ctx.rechte.wuerdigen) {
    return `Sie sind als ${l.namen.name(l.nutzerId)} angemeldet. Die Würdigung ist der zuständigen Berufsträgerin bzw. dem zuständigen Berufsträger vorbehalten und wird serverseitig erzwungen.`;
  }
  return null;
}

function P153Karte({ l }: { l: Lage }) {
  const { f } = l;
  if (!p153Erforderlich(f.auswirkung)) {
    return (
      <p className="card flex items-center gap-2 px-6 py-4 text-sm text-muted">
        <Info className="h-4 w-4" aria-hidden="true" /> Kein §-153-Pfad: steuerliche Auswirkung
        „nein“.
      </p>
    );
  }
  const fertig = p153Abschliessend(f.p153?.entscheidung);
  return (
    <P153Block
      action={l.binden(p153EntscheidenAction)}
      bisher={f.p153?.entscheidung ?? null}
      optionen={P153_OPTIONEN.map((o) => ({
        wert: o,
        titel: p153OptionTitel(o),
        text: P153_ERLAEUTERUNG[o],
      }))}
      sperrGrund={l.p153Sperre}
      sperrHinweis={p153Hinweis(l)}
      offen={!fertig && l.offen}
      heute={l.heute}
      ergebnis={
        f.p153
          ? {
              label: p153Label(f.p153.entscheidung),
              begruendung: f.p153.begruendung,
              frist: f.p153.frist ? isoDatumText(f.p153.frist) : null,
              beleg: `${l.namen.name(f.p153.von)} · ${isoZeitText(f.p153.am)}`,
            }
          : null
      }
    />
  );
}

function Nachkontrolle({ l }: { l: Lage }) {
  const { f, ctx } = l;
  const nk = f.nachkontrolle;
  const ersetzbar = !nk || nk.anzeige === 'MIT_BEFUND' || nk.anzeige === 'ENTFALLEN';
  const moeglich = f.status === 'MASSNAHMEN_OFFEN' || f.status === 'NACHKONTROLLE';
  const quelleCode = f.durchfuehrung?.code ?? kontrollCode(f.quelleText);
  return (
    <Karte
      id="fs-nachkontrolle"
      titel="Nachkontrolle"
      rechts={
        nk ? (
          <AnzeigeBadge status={nk.anzeige} />
        ) : (
          <span className="badge-gray">nicht angelegt</span>
        )
      }
    >
      <div className="flex flex-col gap-2 px-6 py-4">
        {nk ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <Link
                href={l.mitStand(`${l.basis}/durchfuehrungen/${encodeURIComponent(nk.id)}`)}
                className="text-sm font-medium text-primary hover:underline"
              >
                {nk.code} · <TcmsText>{nk.titel}</TcmsText>
              </Link>
              <p className="text-xs text-muted mt-1">
                <TcmsText>{nk.periodeLabel}</TcmsText> · fällig {isoDatumText(nk.faelligAm)}
                {nk.ausserplanmaessig ? ' · außerplanmäßig' : ''}
              </p>
            </div>
            <span className="text-xs text-muted">
              Wirksamkeit der Maßnahmen wird mit dieser Durchführung belegt.
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted">
            Die Wirksamkeit der Maßnahmen wird mit einer Kontrolldurchführung belegt (ab Status
            „Maßnahmen offen“). Geschlossen wird erst nach Nachkontrolle ohne Befund und
            Gegenzeichnung.
          </p>
        )}
        {ersetzbar && l.offen ? (
          <div className="mt-2">
            <NachkontrolleDialog
              action={l.binden(nachkontrolleAction)}
              sperre={l.sperre ?? (moeglich ? null : 'Nachkontrolle ab Status „Maßnahmen offen“')}
              neu={nk !== null}
              kontrollen={ctx.kontrollen.map((k) => [k.id, `${k.code} · ${k.titel}`] as const)}
              vorschlag={f.durchfuehrung?.kontrolleId ?? nk?.kontrolleId ?? ''}
              vorschlagHinweis={
                quelleCode
                  ? `Vorbelegt mit der Kontrolle, aus der die Feststellung stammt (${quelleCode}).`
                  : null
              }
              heute={l.heute}
              vorschlagFaellig={l.plus14}
            />
          </div>
        ) : null}
      </div>
    </Karte>
  );
}

// ---------------------------------------------------------------------------
// Seitenspalte
// ---------------------------------------------------------------------------

function quelleVerweis(l: Lage): { href: string; text: string } | null {
  const { f } = l;
  if (f.durchfuehrung) {
    return {
      href: l.mitStand(`${l.basis}/durchfuehrungen/${encodeURIComponent(f.durchfuehrung.id)}`),
      text: f.durchfuehrung.code,
    };
  }
  if (f.ereignis) {
    return {
      href: l.mitStand(`${l.basis}/ereignisse?e=${encodeURIComponent(f.ereignis.id)}`),
      text: `${f.ereignis.nummer} (${f.ereignis.typ})`,
    };
  }
  return null;
}

function Erfassung({ l }: { l: Lage }) {
  const { f, namen } = l;
  const verweis = quelleVerweis(l);
  const zeile = (label: string, wert: ReactNode) => (
    <div className="flex items-center justify-between gap-2 px-6 py-2 border-b border-default last:border-b-0">
      <dt className="text-secondary">{label}</dt>
      <dd className="flex flex-wrap items-center justify-end gap-1.5">{wert}</dd>
    </div>
  );
  return (
    <Karte id="fs-erfassung" titel="Erfassung">
      <dl className="text-sm">
        {zeile(
          'Quelle',
          <>
            <span className="badge-gray">{QUELLE_LABEL[f.quelle]}</span>
            {verweis ? (
              <Link href={verweis.href} className="font-mono text-xs underline">
                <TcmsText>{verweis.text}</TcmsText>
              </Link>
            ) : (
              <span className="text-xs text-muted" {...TCMS_TEXT_ISOLIERT}>
                {f.quelleText}
              </span>
            )}
            {f.durchfuehrung ? (
              <span className="text-xs text-muted">
                (<TcmsText>{f.durchfuehrung.periodeLabel}</TcmsText>)
              </span>
            ) : null}
          </>,
        )}
        {zeile('Erfasst von', namen.name(f.erfasstVon))}
        {zeile('Erfasst am', <span className="font-mono">{isoDatumText(f.erfasstAm)}</span>)}
        {zeile('Schwere', <KlasseBadge klasse={f.schwere} />)}
        {zeile('Klasse', <span className="badge-gray">{FESTSTELLUNG_KLASSE_LABEL[f.klasse]}</span>)}
        {zeile('Status', <FeststellungStatusBadge status={f.status} />)}
      </dl>
    </Karte>
  );
}

function Verlauf({ l }: { l: Lage }) {
  const { f, namen } = l;
  return (
    <Karte
      id="fs-verlauf"
      titel="Verlauf"
      rechts={<span className="text-[11px] text-muted">aus dem Audit-Log</span>}
    >
      {f.verlauf.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted">Keine Einträge.</p>
      ) : (
        <ol>
          {f.verlauf.map((v, i) => (
            <li
              key={`${v.pos}-${i}`}
              className="px-6 py-2.5 text-xs border-b border-default last:border-b-0"
            >
              <span className="font-mono text-muted">{isoZeitText(v.at)}</span> ·{' '}
              <span className="font-medium">{v.actorId ? namen.name(v.actorId) : 'System'}</span> ·{' '}
              <TcmsText>{v.text}</TcmsText>
            </li>
          ))}
        </ol>
      )}
    </Karte>
  );
}

function VerwerfenAntrag({ l }: { l: Lage }) {
  const { f, namen } = l;
  const antrag = f.verwerfen!;
  const eigener = antrag.beantragtVon === l.nutzerId;
  // Vier-Augen (Anzeige): wer beantragt hat, bestätigt nicht.
  const bestaetigenSperre = l.ctx.historisch
    ? NUR_AKTUELL
    : eigener
      ? TCMS_KEIN_RECHT.VIER_AUGEN
      : null;
  return (
    <div className="alert-warning text-sm">
      <p>
        <strong>Verwerfen beantragt</strong> von {namen.name(antrag.beantragtVon)}:
      </p>
      <p className="text-xs mt-1">
        <TcmsText>{antrag.begruendung}</TcmsText>
      </p>
      <div className="mt-2 flex flex-wrap items-start gap-2">
        <AktionsKnopf
          action={l.binden(verwerfenBestaetigenAction)}
          className="btn-danger-outline text-xs py-1"
          disabled={bestaetigenSperre !== null}
          title={bestaetigenSperre ?? undefined}
          rueckfrage={{
            titel: `${f.nummer} verwerfen`,
            text: 'Verwerfen bestätigen? Die Feststellung wird verworfen.',
            bestaetigen: 'Verwerfen bestätigen',
            gefahr: true,
          }}
        >
          Verwerfen bestätigen
        </AktionsKnopf>
        <AktionsKnopf
          action={l.binden(verwerfenAblehnenAction)}
          className="btn-secondary text-xs py-1"
          disabled={l.sperre !== null}
          title={l.sperre ?? undefined}
        >
          {eigener ? 'Antrag zurückziehen' : 'Ablehnen'}
        </AktionsKnopf>
      </div>
    </div>
  );
}

function WeitereAktionen({ l }: { l: Lage }) {
  const { f, ctx } = l;
  const verwerfenOffen = f.verwerfen !== null && f.status !== 'VERWORFEN';
  return (
    <Karte id="fs-weitere" titel="Weitere Aktionen">
      <div className="flex flex-col gap-3 px-6 py-4">
        {verwerfenOffen ? (
          <VerwerfenAntrag l={l} />
        ) : f.status !== 'VERWORFEN' ? (
          <VerwerfenDialog
            action={l.binden(verwerfenBeantragenAction)}
            nummer={f.nummer}
            sperre={l.sperre}
          />
        ) : null}
        <div className="border-t border-default pt-3">
          <VertraulichSchalter
            action={l.binden(vertraulichAction)}
            wert={f.vertraulichAktuell}
            gesperrtGrund={
              ctx.historisch ? NUR_AKTUELL : ctx.rechte.wuerdigen ? null : TCMS_KEIN_RECHT.WUERDIGEN
            }
          />
          <p className="text-[11px] text-muted mt-1">nur für Beteiligte sichtbar</p>
        </div>
      </div>
    </Karte>
  );
}
