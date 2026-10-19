// =============================================================================
// Detailbereich einer Kontrolle (TCMS Stufe 3, portiert aus der Demo
// components/kontrollen/drawer.tsx). Anzeige von `GET …/kontrollen/:id`
// (Stand, Durchführungen, Stände, Audit) bzw. des Listeneintrags; Risiken aus
// dem Kontext; Namen aus der kanzleikonsole.
//
// Aktionen: Design beurteilen, Frequenzabweichung beantragen / entscheiden /
// aufheben, Zuständigkeiten ändern. Vier-Augen-Anzeige: Wer die Abweichung
// beantragt hat, sieht den Antrag mit Namen, bekommt die Entscheidung aber
// nicht angeboten; entscheidend bleibt der Dienst.
//
// Lücken der Pflichtattribute liefert seit TCMS s7 der Dienst
// (`pflichtattributeLuecken`, feste Texte in fester Reihenfolge; leer genau
// bei `pflichtattributeOk`) – keine eigene Prüfung. Die Häufigkeitsmatrix ist
// eine Anzeige-Vorschau aus @taxtronik/tcms-domain; maßgeblich ist `ableitung`.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { CalendarClock, Check, ShieldCheck, Users } from 'lucide-react';
import type { KontextAntwort, KontrolleDetail, KontrolleEintrag } from '@taxtronik/tcms-contract';
import {
  AUSFUEHRUNG_LABEL,
  fmtEur,
  frequenzLabel,
  GOVERNANCE_ERKLAERUNG,
  katalogKontrolle,
  KLASSE_LABEL,
  KONTROLLART_LABEL,
  MATRIX_ZEILEN,
  matrixFrequenz,
  mindestensSoStreng,
  PARTEI_LABEL,
  periodeFuer,
  TURNUS_LABEL,
  type GovernanceTyp,
  type Klasse,
} from '@taxtronik/tcms-domain';
import type { TcmsNamen } from '@/server/tcms/namen';
import type { TcmsSeitenZustand } from '@/server/tcms/zustand';
import { GtBadge, KlasseBadge } from '../badges';
import {
  AktionsKnopf,
  AuswahlFeld,
  BegruendungsDialog,
  HakenFeld,
  OptionenFeld,
} from '../bereich-b/aktion';
import { Abschnitt, DetailBereich, DetailZustand, SperrHinweis } from '../bereich-b/detail';
import type { TcmsAktion } from '../bereich-b/ergebnis';
import { mitStand, selbstBeantragt } from '../bereich-b/seite';
import { isoDatumText, isoZeitText } from '../format';
import { DesignBadge, DurchfuehrungBadge, SchluesselBadge } from './badges';
import {
  BETRIEB_BADGE,
  BETRIEB_KURZ,
  BETRIEB_LABEL,
  KONTROLL_AUDIT_LABEL,
  kontrolleAuditText,
} from './labels';
import { personKurz } from './liste';
import { ZustaendigkeitFormular, type PersonOption } from './zustaendigkeit';

export interface KontrollAktionen {
  design: TcmsAktion;
  abweichungBeantragen: TcmsAktion;
  abweichungEntscheiden: TcmsAktion;
  abweichungAufheben: TcmsAktion;
  zustaendigkeit: TcmsAktion;
}

const SPALTEN: ReadonlyArray<{
  key: 'hoch' | 'mittel' | 'gering';
  label: string;
  klassen: Klasse[];
}> = [
  { key: 'hoch', label: 'kritisch / hoch', klassen: ['KRITISCH', 'HOCH'] },
  { key: 'mittel', label: 'mittel', klassen: ['MITTEL'] },
  { key: 'gering', label: 'gering', klassen: ['GERING'] },
];

const TURNUS_AUSWAHL = (['MONATLICH', 'QUARTALSWEISE', 'JAEHRLICH', 'KEIN'] as const).map((t) => ({
  wert: t,
  label: t === 'KEIN' ? 'kein Turnus' : TURNUS_LABEL[t],
}));

/** Gemeinsame Angaben der Abschnitte. */
interface Teil {
  k: KontrolleEintrag;
  daten: KontrolleDetail | null;
  ctx: KontextAntwort;
  namen: TcmsNamen;
  ich: string;
  sperre: string | null;
  basis: string;
  link: (href: string) => string;
  risikoHref: (risikoId: string) => string;
  aktionen: KontrollAktionen;
  personen: { seite: readonly PersonOption[]; kanzlei: readonly PersonOption[] } | null;
}

function zeitpunkt(iso: string | null | undefined): string {
  return iso && /T00:00:00(\.000)?Z$/.test(iso) ? isoDatumText(iso) : isoZeitText(iso);
}

function Feld({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="label-sm">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function KontrolleDetailBereich({
  eintrag,
  detail,
  ctx,
  namen,
  ich,
  sperre,
  basis,
  stand,
  schliessenHref,
  risikoHref,
  aktionen,
  personen,
}: {
  /** Eintrag der Liste (Fallback, falls das Detail nicht abrufbar ist). */
  eintrag: KontrolleEintrag;
  detail: { ok: true; daten: KontrolleDetail } | { ok: false; zustand: TcmsSeitenZustand } | null;
  ctx: KontextAntwort;
  namen: TcmsNamen;
  ich: string;
  sperre: string | null;
  basis: string;
  stand: string | null;
  schliessenHref: string;
  risikoHref: (risikoId: string) => string;
  aktionen: KontrollAktionen;
  /** Auswahllisten (nur ohne Sperre geladen). */
  personen: { seite: readonly PersonOption[]; kanzlei: readonly PersonOption[] } | null;
}) {
  const daten = detail?.ok ? detail.daten : null;
  const k = daten?.kontrolle ?? eintrag;
  const t: Teil = {
    k,
    daten,
    ctx,
    namen,
    ich,
    sperre,
    basis,
    link: (href) => mitStand(href, stand),
    risikoHref,
    aktionen,
    personen,
  };
  return (
    <DetailBereich
      id={`tcms-kontrolle-${k.id}`}
      titel={`${k.code} · ${k.titel}`}
      schliessenHref={schliessenHref}
      plaketten={
        <>
          {k.schluessel ? <SchluesselBadge /> : null}
          <span className="badge-gray">{PARTEI_LABEL[k.partei]}</span>
        </>
      }
      unterzeile={
        <>
          {KONTROLLART_LABEL[k.art]} · {AUSFUEHRUNG_LABEL[k.ausfuehrung]} · GT {k.gt ?? '—'} ·
          Frequenz {frequenzLabel(k.frequenz)} · Stand v{k.version}
        </>
      }
    >
      <SperrHinweis grund={sperre} />
      {detail && !detail.ok ? <DetailZustand zustand={detail.zustand} /> : null}
      {k.naechste?.anzeige === 'UEBERFAELLIG' ? (
        <p className="alert-error-sm" role="note">
          <strong>Überfällig:</strong> {k.naechste.periodeLabel}, fällig{' '}
          {isoDatumText(k.naechste.faelligAm)}.
        </p>
      ) : null}
      <BeschreibungAbschnitte t={t} />
      <FrequenzAbschnitt t={t} />
      <DesignAbschnitt t={t} />
      <ZustaendigkeitAbschnitt t={t} />
      <DurchfuehrungenAbschnitt t={t} />
      <StaendeAbschnitt t={t} />
      <HistorieAbschnitt t={t} />
    </DetailBereich>
  );
}

// ---------------------------------------------------------------------------
// Ziel, Schritte, Kennzahlen
// ---------------------------------------------------------------------------

/** Pflichtattribute laut Dienst: dokumentiert oder die fehlenden als Liste (TCMS s7). */
export function PflichtattributHinweis({
  k,
}: {
  k: Pick<KontrolleEintrag, 'pflichtattributeOk' | 'pflichtattributeLuecken'>;
}) {
  if (k.pflichtattributeOk && k.pflichtattributeLuecken.length === 0) {
    return <p className="text-xs text-muted">Pflichtattribute dokumentiert (laut Tax-CMS).</p>;
  }
  return (
    <div className="alert-warning text-xs" role="note">
      <p>Pflichtattribute unvollständig (laut Tax-CMS). Es fehlt:</p>
      {k.pflichtattributeLuecken.length ? (
        <ul className="list-disc pl-5 mt-1">
          {k.pflichtattributeLuecken.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1">Die Angaben im Tax-CMS prüfen.</p>
      )}
    </div>
  );
}

function BeschreibungAbschnitte({ t }: { t: Teil }) {
  const { k } = t;
  const kat = katalogKontrolle(k.code);
  return (
    <>
      <Abschnitt titel="Ziel und Beschreibung" offen>
        <p className="text-sm text-secondary">{k.ziel}</p>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Feld label="Art · Ausführung">
            {KONTROLLART_LABEL[k.art]} · {AUSFUEHRUNG_LABEL[k.ausfuehrung]}
          </Feld>
          <Feld label="Partei">
            {PARTEI_LABEL[k.partei]}
            {kat?.review ? `, ${kat.review}` : ''}
          </Feld>
          <Feld label="Nachweisanforderung">{k.nachweis}</Feld>
          <Feld label="Mindestnachweise · Fälligkeit">
            {k.mindestNachweise} {k.mindestNachweise === 1 ? 'Datei' : 'Dateien'} ·{' '}
            {k.faelligNachTagen} Tage nach Periodenende
          </Feld>
        </dl>
        <PflichtattributHinweis k={k} />
      </Abschnitt>
      <Abschnitt titel={`Schritte (${k.schritte.length})`} offen>
        <ol className="list-decimal pl-5 space-y-1">
          {k.schritte.map((s) => (
            <li key={s.titel} className="text-sm">
              <span className="font-medium">{s.titel}</span>
              {s.hinweis ? <span className="text-xs text-muted"> – {s.hinweis}</span> : null}
            </li>
          ))}
        </ol>
      </Abschnitt>
      <Abschnitt titel="Kennzahlen und Toleranz">
        {k.kennzahlen.length === 0 ? (
          <p className="text-sm text-muted">Keine Kennzahlen definiert.</p>
        ) : (
          <ul className="space-y-1">
            {k.kennzahlen.map((z) => (
              <li key={z.key} className="flex justify-between gap-3 text-sm">
                <span>{z.label}</span>
                <span className="font-mono text-xs text-muted">
                  {z.differenzAus
                    ? `Differenz aus ${z.differenzAus.join(' − ')}`
                    : z.sollEur != null
                      ? `Soll ${fmtEur(z.sollEur)}`
                      : 'ohne Soll'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-secondary">
          Toleranz:{' '}
          {k.toleranzEur != null ? fmtEur(k.toleranzEur) : 'keine Betragstoleranz festgelegt'}
        </p>
      </Abschnitt>
    </>
  );
}

// ---------------------------------------------------------------------------
// Frequenz und Abweichung
// ---------------------------------------------------------------------------

function MatrixVorschau({ t }: { t: Teil }) {
  const { k } = t;
  const periode = periodeFuer(k.vorlage, t.ctx.programm?.erklaerungsTurnus ?? 'MONATLICH');
  const quelle = k.ableitung.quelle;
  const risiken = t.ctx.risiken.filter((r) => k.risikoIds.includes(r.id));
  const zellenRisiken = (gt: GovernanceTyp, klassen: Klasse[]) =>
    risiken.filter((r) => r.gt === gt && klassen.includes(r.bewertung.brutto.klasse));
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <caption className="sr-only">
            Häufigkeitsmatrix Governance-Typ × Bruttoklasse (Startwerte); markiert sind die Zellen
            der verknüpften Risiken
          </caption>
          <thead>
            <tr>
              <th scope="col" className="th">
                GT
              </th>
              {SPALTEN.map((s) => (
                <th key={s.key} scope="col" className="th">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MATRIX_ZEILEN.map((z) => (
              <tr key={z.gt} className="border-t border-default">
                <th
                  scope="row"
                  className="px-2 py-1.5 text-left"
                  title={GOVERNANCE_ERKLAERUNG[z.gt]}
                >
                  <span className="badge-gray font-mono">{z.gt}</span>
                </th>
                {SPALTEN.map((s) => {
                  const drin = zellenRisiken(z.gt, s.klassen);
                  const massgeblich =
                    !!quelle && quelle.gt === z.gt && s.klassen.includes(quelle.brutto);
                  return (
                    <td
                      key={s.key}
                      className={`px-2 py-1.5 align-top ${drin.length ? 'bg-surface-raised' : ''} ${massgeblich ? 'ring-2 ring-inset ring-brand-600' : ''}`}
                    >
                      <span className={drin.length ? 'text-primary' : 'text-muted'}>
                        {z[s.key]}
                      </span>
                      {drin.length ? (
                        <span className="block font-mono">
                          {drin.map((r) => r.code).join(', ')}
                        </span>
                      ) : null}
                      {massgeblich ? <span className="sr-only"> (maßgeblich)</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {risiken.length > 0 ? (
        <ul className="space-y-1">
          {risiken.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <Link
                href={t.risikoHref(r.id)}
                className="inline-flex items-center gap-1 hover:underline"
              >
                <span className="font-mono">{r.code}</span>
                <GtBadge gt={r.gt} />
                <KlasseBadge klasse={r.bewertung.brutto.klasse} />
              </Link>
              <span className={quelle?.code === r.code ? 'font-medium' : 'text-muted'}>
                → {frequenzLabel(matrixFrequenz(r.gt, r.bewertung.brutto.klasse, periode))}
                {quelle?.code === r.code ? ' (maßgeblich)' : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function AbweichungInfo({ t }: { t: Teil }) {
  const { k, namen } = t;
  const a = k.abweichung;
  if (!a) return null;
  const offen = !a.freigegebenVon;
  return (
    <div className={offen ? 'alert-info-sm' : 'alert-warning'}>
      <p className="text-sm">
        <strong>{offen ? 'Abweichung beantragt' : 'Freigegebene Abweichung'}:</strong>{' '}
        {frequenzLabel(a.frequenz)}
        {!mindestensSoStreng(a.frequenz, k.ableitung.mindest) ? (
          <span
            className="badge-yellow ml-2"
            title={`Mindestfrequenz aus der Häufigkeitsmatrix: ${frequenzLabel(k.ableitung.mindest)}`}
          >
            unter Matrixfrequenz
          </span>
        ) : null}
      </p>
      {a.begruendung ? <p className="text-xs mt-1">„{a.begruendung}“</p> : null}
      <p className="text-xs mt-1">
        {a.beantragtVon
          ? `beantragt von ${namen.name(a.beantragtVon)}${a.beantragtAm ? ` · ${zeitpunkt(a.beantragtAm)}` : ''}`
          : ''}
        {a.freigegebenVon ? ` · freigegeben von ${namen.name(a.freigegebenVon)}` : ''}
      </p>
    </div>
  );
}

function AbweichungBedienung({ t }: { t: Teil }) {
  const { k, aktionen, sperre } = t;
  const felder = { kontrolleId: k.id, standId: k.standId };
  if (!k.abweichung) {
    return (
      <BegruendungsDialog
        ausloeser={
          <>
            <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" /> Abweichung beantragen …
          </>
        }
        titel={`${k.code} · Frequenzabweichung beantragen`}
        hinweis={`Maßgeblich: ${frequenzLabel(k.frequenz)}. Mindestfrequenz aus der Häufigkeitsmatrix: ${frequenzLabel(k.ableitung.mindest)} – eine Frequenz darunter braucht eine Begründung. Die Freigabe erteilt in jedem Fall eine zweite Person.`}
        aktion={aktionen.abweichungBeantragen}
        felder={felder}
        bestaetigen="Abweichung beantragen"
        gesperrt={sperre}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <AuswahlFeld
            name="turnus"
            label="Turnus"
            defaultValue={k.frequenz.turnus}
            optionen={TURNUS_AUSWAHL}
          />
          <HakenFeld
            name="anlass"
            label="zusätzlich bei jeder Auslösung"
            defaultChecked={k.frequenz.anlass}
          />
        </div>
      </BegruendungsDialog>
    );
  }
  if (k.abweichung.freigegebenVon) {
    return (
      <BegruendungsDialog
        ausloeser="Abweichung aufheben …"
        titel={`${k.code} · Frequenzabweichung aufheben`}
        hinweis={`Danach gilt wieder die abgeleitete Frequenz (${frequenzLabel(k.ableitung.effektiv)}); das Tax-CMS plant künftige Durchführungen neu.`}
        aktion={aktionen.abweichungAufheben}
        felder={felder}
        bestaetigen="Aufheben"
        vierAugen={false}
        gefahr
        gesperrt={sperre}
      />
    );
  }
  if (selbstBeantragt(t.ich, k.abweichung.beantragtVon)) {
    return (
      <p className="text-xs text-muted" role="note">
        Von Ihnen beantragt – die Entscheidung trifft eine zweite Person.
      </p>
    );
  }
  return (
    <>
      <AktionsKnopf
        aktion={aktionen.abweichungEntscheiden}
        felder={{ ...felder, entscheidung: 'FREIGEBEN' }}
        beschriftung={
          <>
            <Check className="h-3.5 w-3.5" aria-hidden="true" /> Abweichung freigeben
          </>
        }
        gesperrt={sperre}
      />
      <BegruendungsDialog
        ausloeser="Ablehnen …"
        titel={`${k.code} · Frequenzabweichung ablehnen`}
        aktion={aktionen.abweichungEntscheiden}
        felder={{ ...felder, entscheidung: 'ABLEHNEN' }}
        bestaetigen="Ablehnen"
        vierAugen={false}
        gefahr
        gesperrt={sperre}
      />
    </>
  );
}

function FrequenzAbschnitt({ t }: { t: Teil }) {
  const { k } = t;
  const quelle = k.ableitung.quelle;
  const offen = !!k.abweichung && !k.abweichung.freigegebenVon;
  const freigegeben = !!k.abweichung?.freigegebenVon;
  const periode = periodeFuer(k.vorlage, t.ctx.programm?.erklaerungsTurnus ?? 'MONATLICH');
  return (
    <Abschnitt
      titel="Frequenzherleitung"
      offen
      rechts={
        offen ? (
          <span className="badge-purple">Abweichung beantragt</span>
        ) : freigegeben ? (
          <span className="badge-yellow">abweichend</span>
        ) : k.ableitung.abweichendVonVorlage ? (
          <span className="badge-gray">aus Matrix</span>
        ) : null
      }
    >
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Feld label="Vorlage (Katalog)">{frequenzLabel(k.vorlage)}</Feld>
        <Feld label="Mindestfrequenz (Matrix)">{frequenzLabel(k.ableitung.mindest)}</Feld>
        <Feld label="Maßgeblich">
          <strong>{frequenzLabel(k.frequenz)}</strong>
        </Feld>
      </dl>
      <p className="text-xs text-muted">
        {quelle ? (
          <>
            Maßgeblich ist <strong>{quelle.code}</strong> ({quelle.gt} · brutto{' '}
            {KLASSE_LABEL[quelle.brutto]}): Matrixzeile {quelle.gt} – „
            {MATRIX_ZEILEN.find((m) => m.gt === quelle.gt)?.zyklus}“. Hängt eine Kontrolle an
            mehreren Risiken, gilt die strengste Frequenz; maßgeblich ist die strengere aus Vorlage
            und Matrix{freigegeben ? ', hier ersetzt durch die freigegebene Abweichung' : ''}.
          </>
        ) : (
          'Keine verknüpften Risiken – es gilt die Vorlage.'
        )}{' '}
        „Jede Periode“ = {TURNUS_LABEL[periode]}. {k.ableitung.begruendung}
      </p>
      <MatrixVorschau t={t} />
      <AbweichungInfo t={t} />
      <div className="flex flex-wrap items-start gap-2">
        <AbweichungBedienung t={t} />
      </div>
    </Abschnitt>
  );
}

// ---------------------------------------------------------------------------
// Design und Zuständigkeiten
// ---------------------------------------------------------------------------

function DesignAbschnitt({ t }: { t: Teil }) {
  const { k, namen } = t;
  return (
    <Abschnitt
      titel="Designbeurteilung"
      offen={k.design !== 'ANGEMESSEN'}
      rechts={
        <DesignBadge design={k.design} von={personKurz(namen, k.designVon)} am={k.designAm} kurz />
      }
    >
      {k.design === 'NICHT_BEURTEILT' ? (
        <p className="text-sm text-muted">
          Noch nicht beurteilt. Ohne Designbeurteilung zählt die Kontrolle für Netto (Design) nicht.
        </p>
      ) : (
        <>
          <DesignBadge design={k.design} von={namen.name(k.designVon)} am={k.designAm} />
          {k.designBegruendung ? (
            <p className="text-xs text-secondary">„{k.designBegruendung}“</p>
          ) : null}
          <p className="text-xs text-muted">
            Designbeurteilung durch {namen.name(k.designVon)} · {zeitpunkt(k.designAm)}
          </p>
        </>
      )}
      <BegruendungsDialog
        ausloeser={
          <>
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />{' '}
            {k.design === 'NICHT_BEURTEILT' ? 'Design beurteilen …' : 'Neu beurteilen …'}
          </>
        }
        titel={`${k.code} · Designbeurteilung`}
        hinweis="Die Beurteilung wird mit Name und Datum als neuer Kontrollstand dokumentiert. Ein Mangel nimmt den Netto-Abschlag dieser Kontrolle weg."
        aktion={t.aktionen.design}
        felder={{ kontrolleId: k.id, standId: k.standId }}
        bestaetigen="Beurteilung speichern"
        vierAugen={false}
        gesperrt={t.sperre}
      >
        <OptionenFeld
          name="design"
          legende="Ergebnis"
          optionen={[
            { wert: 'ANGEMESSEN', label: 'Designbeurteilung: angemessen' },
            { wert: 'MANGEL', label: 'Mangel' },
          ]}
        />
      </BegruendungsDialog>
    </Abschnitt>
  );
}

function ZustaendigkeitAbschnitt({ t }: { t: Teil }) {
  const { k, namen, personen } = t;
  return (
    <Abschnitt titel="Zuständigkeiten">
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Feld label="Durchführend">{namen.name(k.durchfuehrendId)}</Feld>
        <Feld label="Vertretung">{namen.name(k.vertretungId)}</Feld>
        <Feld label="Gegenzeichnung">
          {k.gegenzeichnungMandant
            ? `${namen.name(k.vertretungId)} (zweite Person beim Mandanten)`
            : namen.name(k.gegenzeichnerId)}
          {k.schluessel ? <span className="text-xs text-muted"> · Pflicht</span> : null}
        </Feld>
      </dl>
      <details className="details-box">
        <summary>
          <Users className="h-4 w-4" aria-hidden="true" /> Zuständigkeiten ändern
        </summary>
        <div className="details-body">
          {personen ? (
            <ZustaendigkeitFormular
              aktion={t.aktionen.zustaendigkeit}
              kontrolleId={k.id}
              standId={k.standId}
              partei={k.partei}
              parteiLabel={PARTEI_LABEL[k.partei]}
              schluessel={k.schluessel}
              seitePersonen={personen.seite}
              kanzleiPersonen={personen.kanzlei}
              durchfuehrendId={k.durchfuehrendId}
              vertretungId={k.vertretungId}
              gegenzeichnerId={k.gegenzeichnerId}
              gegenzeichnungMandant={k.gegenzeichnungMandant}
              gesperrt={t.sperre}
            />
          ) : (
            <p className="text-sm text-muted">{t.sperre ?? 'Zurzeit nicht änderbar.'}</p>
          )}
        </div>
      </details>
    </Abschnitt>
  );
}

// ---------------------------------------------------------------------------
// Durchführungen, Stände, Historie
// ---------------------------------------------------------------------------

type Durchfuehrung = KontrolleDetail['durchfuehrungen'][number];

function DurchfuehrungZeile({ t, d }: { t: Teil; d: Durchfuehrung }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <Link
        href={t.link(`${t.basis}/durchfuehrungen/${encodeURIComponent(d.id)}`)}
        className="text-sm hover:underline"
      >
        {d.periodeLabel}
        {d.ausserplanmaessig ? <span className="text-xs text-muted"> · außerplanmäßig</span> : null}
      </Link>
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted">fällig {isoDatumText(d.faelligAm)}</span>
        <DurchfuehrungBadge d={d} />
        {d.feststellung ? (
          <Link
            href={t.link(`${t.basis}/feststellungen/${encodeURIComponent(d.feststellung.id)}`)}
            className="font-mono text-xs hover:underline"
          >
            {d.feststellung.nummer}
          </Link>
        ) : null}
        {d.durchgefuehrtVon ? (
          <span className="text-xs text-muted">{personKurz(t.namen, d.durchgefuehrtVon)}</span>
        ) : null}
      </span>
    </li>
  );
}

function DurchfuehrungenAbschnitt({ t }: { t: Teil }) {
  const { k, daten } = t;
  const durchf = [...(daten?.durchfuehrungen ?? [])].sort((a, b) =>
    b.faelligAm.localeCompare(a.faelligAm),
  );
  const vergangen = durchf.filter((d) => d.anzeige !== 'GEPLANT').slice(0, 8);
  const geplant = durchf
    .filter((d) => d.anzeige === 'GEPLANT')
    .reverse()
    .slice(0, 3)
    .reverse();
  const leer = !daten
    ? 'Die Durchführungen sind gerade nicht abrufbar.'
    : k.frequenz.turnus === 'KEIN'
      ? 'Keine Durchführungen geplant – Prüfung bei Auslösung (Ereignis).'
      : t.ctx.programm?.wirksamAb
        ? 'Keine Durchführungen geplant.'
        : 'Keine Durchführungen geplant – die Planung beginnt mit dem Wirksamkeitszeitraum.';
  return (
    <Abschnitt
      titel={`Durchführungen (${durchf.length})`}
      offen
      rechts={
        <span className={BETRIEB_BADGE[k.betrieb]} title={BETRIEB_LABEL[k.betrieb]}>
          Betrieb: {BETRIEB_KURZ[k.betrieb]}
        </span>
      }
    >
      {durchf.length === 0 ? (
        <p className="text-sm text-muted">{leer}</p>
      ) : (
        <ul className="space-y-1.5">
          {[...geplant, ...vergangen].map((d) => (
            <DurchfuehrungZeile key={d.id} t={t} d={d} />
          ))}
        </ul>
      )}
      {durchf.length > geplant.length + vergangen.length ? (
        <p className="text-xs text-muted">
          … weitere {durchf.length - geplant.length - vergangen.length} im{' '}
          <Link className="underline" href={t.link(`${t.basis}/kalender`)}>
            Kalender
          </Link>
        </p>
      ) : null}
    </Abschnitt>
  );
}

function StaendeAbschnitt({ t }: { t: Teil }) {
  const { k, daten, namen } = t;
  const staende = daten?.staende ?? [];
  return (
    <Abschnitt titel={`Stand-Historie (${staende.length})`}>
      {staende.length === 0 ? (
        <p className="text-sm text-muted">Keine Stände bis zum Stichtag.</p>
      ) : (
        <ul className="space-y-1.5">
          {staende.map((s) => (
            <li key={s.id} className="flex items-start gap-2">
              <span className={`${s.id === k.standId ? 'badge-brand' : 'badge-gray'} font-mono`}>
                v{s.version}
              </span>
              <span className="flex flex-col">
                <span className="text-sm">{s.aenderungen.join(', ') || 'Erster Stand'}</span>
                <span className="text-xs text-muted">
                  {zeitpunkt(s.gueltigAb)} – {s.gueltigBis ? zeitpunkt(s.gueltigBis) : 'aktuell'} ·{' '}
                  {namen.name(s.erstelltVon)}
                  {s.design !== 'NICHT_BEURTEILT'
                    ? ` · Design ${s.design === 'ANGEMESSEN' ? 'angemessen' : 'Mangel'}`
                    : ''}
                  {s.abweichung
                    ? ` · Abweichung ${frequenzLabel({ turnus: s.abweichung.turnus, anlass: s.abweichung.anlass })}${s.abweichung.freigegebenVon ? '' : ' (beantragt)'}`
                    : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">
        Laufende Durchführungen behalten ihre Version; jede Änderung schreibt einen neuen Stand mit
        Gültig-ab fort.
      </p>
    </Abschnitt>
  );
}

function HistorieAbschnitt({ t }: { t: Teil }) {
  const { daten, namen } = t;
  const audit = daten?.audit ?? [];
  return (
    <Abschnitt titel="Historie">
      {audit.length === 0 ? (
        <p className="text-sm text-muted">Keine protokollierten Änderungen an dieser Kontrolle.</p>
      ) : (
        <ul className="space-y-1">
          {audit.map((a) => {
            const zusatz = kontrolleAuditText(a.detail, (id) => namen.name(id));
            return (
              <li key={a.pos} className="flex flex-wrap items-start gap-2 text-sm">
                <span className="text-xs font-mono text-muted shrink-0">{zeitpunkt(a.at)}</span>
                <span className="text-xs text-secondary shrink-0">{namen.name(a.actorId)}</span>
                <span className="grow">
                  {KONTROLL_AUDIT_LABEL[a.aktion] ?? a.aktion}
                  {zusatz ? <span className="text-xs text-muted"> · {zusatz}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Abschnitt>
  );
}
