// =============================================================================
// Darstellung einer Kontrolldurchführung (TCMS Stufe 3, Bereich C). Anzeige
// der Antwort von `durchfuehrungLesen`; Bedienelemente nur, wenn `rechte` des
// Dienstes sie erlauben, gesperrte mit dem Grund des Dienstes. Im historischen
// Stand nur Lesen (Abweichung von der Demo: dort blieben Knöpfe sichtbar und
// die Aktion lehnte ab).
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  ArrowLeft,
  Ban,
  Building2,
  CheckCircle2,
  Circle,
  CircleDot,
  FileCheck,
  KeyRound,
  Link2,
  Lock,
  Plus,
  RotateCcw,
  Save,
  Send,
  TriangleAlert,
  UserCheck,
  Users,
} from 'lucide-react';
import {
  DF_MIN_BEFUND_KOMMENTAR,
  type DurchfuehrungDetail,
  type KontextAntwort,
} from '@taxtronik/tcms-contract';
import { PARTEI_LABEL } from '@taxtronik/tcms-domain';
import { AnzeigeBadge, GtBadge } from '@/components/tcms/badges';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import { DurchfuehrungEditor } from '@/components/tcms/durchfuehrung/editor';
import {
  AktionsKnopf,
  BegruendungsDialog,
  EntwurfFormular,
  GegenzeichnenMitBefundDialog,
  type TcmsErgebnis,
  type TcmsFormAktion,
} from '@/components/tcms/durchfuehrung/formulare';
import {
  KontrollbeschreibungKarte,
  LetzteKarte,
  NachweiseKarte,
  PersonenbelegeKarte,
  RisikenKarte,
  VerlaufKarte,
} from '@/components/tcms/durchfuehrung/karten';
import { periodeKurz, werteAusListe } from '@/components/tcms/durchfuehrung/werte';
import { FeststellungBezeichnung } from '@/components/tcms/feststellung';
import { isoDatumText, isoZeitText } from '@/components/tcms/format';
import { TcmsKopf, type TcmsKopfDaten } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import { formatUploadLimit, MAX_UPLOAD_BYTES_BY_KIND } from '@/lib/upload-limits.mjs';
import type { DurchfuehrungKanzleiDaten } from '@/server/tcms/durchfuehrung/kanzlei-daten';
import type { TcmsNamen } from '@/server/tcms/namen';
import type { TcmsMandantSeite } from '@/server/tcms/seite';
import {
  durchfuehrungBeginnenAction,
  durchfuehrungGegenzeichnenAction,
  durchfuehrungSpeichernAction,
  durchfuehrungZurueckweisenAction,
  entfallenAblehnenAction,
  entfallenBeantragenAction,
  entfallenFreigebenAction,
  nachtragAnlegenAction,
  nachweisAuswaehlenAction,
  nachweisEntfernenAction,
  nachweisHochladenAction,
} from './actions';

const FORM_ID = 'tcms-durchfuehrung-entwurf';
const OFFEN: readonly string[] = ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'];

/** Server Action mit gebundenem Mandanten und gebundener Durchführung. */
type GebundeneAktion = (
  mandantId: string,
  durchfuehrungId: string,
  vorher: TcmsErgebnis | null,
  formData: FormData,
) => Promise<TcmsErgebnis>;

/** Gemeinsame Lage aller Teile der Ansicht (aus der Antwort des Dienstes abgeleitet). */
interface Lage {
  d: DurchfuehrungDetail;
  namen: TcmsNamen;
  basis: string;
  nutzerId: string;
  aktuell: boolean;
  bearbeitbar: boolean;
  abgeschlossen: boolean;
  offenerAntrag: boolean;
  /** Anzeige der Berufsträger des Mandanten (aus der kanzleikonsole). */
  bt: string;
  mitStand: (href: string) => string;
  binden: (a: GebundeneAktion) => TcmsFormAktion;
}

function Zeile({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-2">
      {icon}
      <span>{children}</span>
    </span>
  );
}

const icon = (Icon: typeof Ban) => <Icon className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />;

function lageAus(
  seite: TcmsMandantSeite,
  d: DurchfuehrungDetail,
  kanzlei: DurchfuehrungKanzleiDaten,
  namen: TcmsNamen,
): Lage {
  const aktuell = !d.historisch;
  return {
    d,
    namen,
    basis: seite.basis,
    nutzerId: seite.session.user.staffId,
    aktuell,
    bearbeitbar: aktuell && d.rechte.bearbeiten.erlaubt && d.status !== 'GEPLANT',
    abgeschlossen: d.status === 'OHNE_BEFUND' || d.status === 'MIT_BEFUND',
    offenerAntrag: d.status !== 'ENTFALLEN' && !!d.entfallenBegruendung,
    bt:
      kanzlei.berufstraeger.length > 0
        ? kanzlei.berufstraeger.map((id) => namen.name(id)).join(', ')
        : 'die zuständige Berufsträgerin bzw. den zuständigen Berufsträger',
    mitStand: (href) =>
      d.historisch ? `${href}${href.includes('?') ? '&' : '?'}stand=${d.stand}` : href,
    binden: (a) => a.bind(null, seite.mandantId, d.id),
  };
}

export function DurchfuehrungAnsicht({
  seite,
  d,
  ctx,
  kanzlei,
  namen,
  anhaengbar,
}: {
  seite: TcmsMandantSeite;
  d: DurchfuehrungDetail;
  ctx: KontextAntwort;
  kanzlei: DurchfuehrungKanzleiDaten;
  namen: TcmsNamen;
  anhaengbar: boolean;
}) {
  const l = lageAus(seite, d, kanzlei, namen);
  const kopf: TcmsKopfDaten = {
    teilbereich: ctx.teilbereich,
    aktivePhase: ctx.programm ? ctx.aktivePhase : null,
    historisch: d.historisch,
    stand: d.stand,
    heute: d.heute,
    ausgeblendet: ctx.ausgeblendet,
  };
  const zurueck = (
    <Link href={l.mitStand(`${l.basis}/durchfuehrungen`)} className="back-link mb-0">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> zurück zu Durchführungen
    </Link>
  );
  if (!d.vorhandenZumStand) {
    return (
      <>
        <TcmsKopf daten={kopf} titel={zurueck} />
        <div className="card">
          <TcmsLeer
            icon={Lock}
            text={`Diese Durchführung wurde erst am ${isoDatumText(d.createdAt)} angelegt und existierte zum Stichtag noch nicht.`}
          >
            <Link
              href={`${l.basis}/durchfuehrungen/${encodeURIComponent(d.id)}`}
              className="btn-secondary"
            >
              Zum aktuellen Stand
            </Link>
          </TcmsLeer>
        </div>
      </>
    );
  }
  const kv = ctx.kontrollen.find((x) => x.id === d.kontrolle.id) ?? null;
  return (
    <>
      <TcmsKopf daten={kopf} titel={zurueck} />
      <Kopfzeile l={l} gt={kv?.gt ?? null} />
      <Personen l={l} />
      <TcmsPflichthinweis />
      <div className="flex flex-col gap-2.5 my-4">
        <StatusHinweise l={l} />
        <EntfallenHinweise l={l} />
        <PrueferHinweise l={l} />
        <HistorischHinweis d={d} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-8">
          <Hauptspalte l={l} kanzlei={kanzlei} anhaengbar={anhaengbar} />
        </div>
        <div className="flex flex-col gap-4 xl:col-span-4">
          <KontrollbeschreibungKarte d={d} namen={namen} frequenz={kv?.frequenz ?? null} />
          <RisikenKarte
            d={d}
            href={(rid) => l.mitStand(`${l.basis}/risiken?risiko=${encodeURIComponent(rid)}`)}
          />
          <LetzteKarte
            d={d}
            href={(x) => l.mitStand(`${l.basis}/durchfuehrungen/${encodeURIComponent(x)}`)}
          />
          <PersonenbelegeKarte d={d} namen={namen} />
          <VerlaufKarte d={d} namen={namen} />
        </div>
      </div>
      <div className="mt-4">
        <Fussleiste l={l} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Kopf: Kontrolle, Periode, Status, Partei, Personen
// ---------------------------------------------------------------------------

function kopfRechts({ d, namen }: Lage): string {
  const teile = [`fällig bis ${isoDatumText(d.faelligAm)}`];
  if (d.eingereichtAm) {
    teile.push(`eingereicht ${isoZeitText(d.eingereichtAm)} von ${namen.name(d.durchgefuehrtVon)}`);
  } else if (d.begonnenAm) {
    teile.push(`begonnen ${isoZeitText(d.begonnenAm)}`);
  }
  if (d.abgeschlossenAm) {
    teile.push(
      `gegengezeichnet ${isoZeitText(d.abgeschlossenAm)} von ${namen.name(d.gegengezeichnetVon)}`,
    );
  }
  return teile.join(' · ');
}

function Kopfzeile({ l, gt }: { l: Lage; gt: KontextAntwort['kontrollen'][number]['gt'] }) {
  const { d } = l;
  const k = d.kontrolle;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-primary mr-1">
          {k.code} · {k.titel}
        </h2>
        <span className="badge-brand">Periode: {d.periodeLabel}</span>
        <AnzeigeBadge status={d.anzeige} />
        <span className="badge-gray">Partei: {PARTEI_LABEL[k.partei]}</span>
        {k.schluessel ? (
          <span className="badge-brand gap-1" title="Schlüsselkontrolle">
            <KeyRound className="h-3 w-3" aria-hidden="true" /> Schlüssel
          </span>
        ) : null}
        {gt ? <GtBadge gt={gt} /> : null}
        {d.ausserplanmaessig ? <span className="badge-gray">außerplanmäßig</span> : null}
      </div>
      <span className="text-xs text-muted">{kopfRechts(l)}</span>
    </div>
  );
}

function Person({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-1">
      <dt className="text-muted">{label}:</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Personen({ l }: { l: Lage }) {
  const { d, namen } = l;
  const k = d.kontrolle;
  const gegenzeichnung = d.gegengezeichnetVon
    ? namen.name(d.gegengezeichnetVon)
    : k.gegenzeichnungMandant
      ? `Kanzlei (${l.bt})`
      : namen.name(k.gegenzeichnerId);
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary mb-4">
      <Person label="Verantwortlich">{namen.name(k.durchfuehrendId)}</Person>
      <Person label="Vertretung">{namen.name(k.vertretungId)}</Person>
      <Person label="Durchgeführt von">
        {d.durchgefuehrtVon && d.begonnenAm ? namen.name(d.durchgefuehrtVon) : '—'}
      </Person>
      {k.gegenzeichnungMandant ? (
        <Person label="Bestätigung Mandant">
          {d.mandantBestaetigtVon
            ? namen.name(d.mandantBestaetigtVon)
            : `zweite Person (vorgesehen ${namen.name(k.gegenzeichnerId)})`}
        </Person>
      ) : null}
      <Person label="Gegenzeichnung">{gegenzeichnung}</Person>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Zustandshinweise
// ---------------------------------------------------------------------------

function StatusHinweise({ l }: { l: Lage }) {
  const { d, namen } = l;
  const lnk = (id: string) => l.mitStand(`${l.basis}/durchfuehrungen/${encodeURIComponent(id)}`);
  return (
    <>
      {d.anzeige === 'UEBERFAELLIG' ? (
        <div className="alert-error" role="alert">
          <Zeile icon={icon(TriangleAlert)}>
            <strong>Überfällig.</strong> Fälligkeit {isoDatumText(d.faelligAm)} überschritten —
            Eskalation an {l.bt}. Netto (Betrieb) der verknüpften Risiken steigt, bis die
            Durchführung nachgeholt ist.
          </Zeile>
        </div>
      ) : null}
      {d.original ? (
        <div className="alert-info-sm">
          <Zeile icon={icon(Link2)}>
            <strong>Nachtrag</strong> zu{' '}
            <Link className="underline" href={lnk(d.original.id)}>
              {d.kontrolle.code} · {d.original.periodeLabel}
            </Link>
            {d.anlass ? ` — ${d.anlass.replace(/^Nachtrag zu [^:]+:\s*/, '')}` : ''}
          </Zeile>
        </div>
      ) : null}
      {d.nachtraege.length > 0 ? (
        <div className="alert-info-sm">
          <Zeile icon={icon(Link2)}>
            Korrekturen als Nachtrag:{' '}
            {d.nachtraege.map((n, i) => (
              <span key={n.id}>
                {i > 0 ? ', ' : ''}
                <Link className="underline" href={lnk(n.id)}>
                  {n.periodeLabel}
                </Link>
              </span>
            ))}
          </Zeile>
        </div>
      ) : null}
      {d.status === 'ZURUECKGEWIESEN' && d.zurueckweisungsgrund ? (
        <div className="alert-warning">
          <Zeile icon={icon(RotateCcw)}>
            <strong>
              Zurückgewiesen von {namen.name(d.zurueckgewiesenVon)}
              {d.zurueckgewiesenAm ? ` am ${isoZeitText(d.zurueckgewiesenAm)}` : ''}:
            </strong>{' '}
            {d.zurueckweisungsgrund}
          </Zeile>
        </div>
      ) : null}
      {d.kontrolle.partei === 'MANDANT' && OFFEN.includes(d.status) ? (
        <div className="alert-info-sm">
          <Zeile icon={icon(Building2)}>
            Durchführung durch den Mandanten im Portal ({namen.name(d.kontrolle.durchfuehrendId)},
            Vertretung {namen.name(d.kontrolle.vertretungId)}).
          </Zeile>
        </div>
      ) : null}
    </>
  );
}

function AntragKnoepfe({ l }: { l: Lage }) {
  const r = l.d.rechte;
  return (
    <span className="flex flex-wrap items-start gap-2">
      {l.d.entfallenVon === l.nutzerId ? (
        <AktionsKnopf
          action={l.binden(entfallenAblehnenAction)}
          className="btn-secondary text-xs py-1"
          disabled={!r.entfallenAblehnen.erlaubt}
          title={r.entfallenAblehnen.grund ?? undefined}
          rueckfrage={{
            titel: 'Antrag zurückziehen',
            text: 'Antrag auf Entfallen zurückziehen?',
            bestaetigen: 'Zurückziehen',
          }}
        >
          Antrag zurückziehen
        </AktionsKnopf>
      ) : (
        <BegruendungsDialog
          ausloeser="Ablehnen …"
          ausloeserClass="btn-secondary text-xs py-1"
          titel="Antrag auf Entfallen ablehnen"
          action={l.binden(entfallenAblehnenAction)}
          bestaetigen="Ablehnen"
          vierAugen={false}
          disabled={!r.entfallenAblehnen.erlaubt}
          disabledGrund={r.entfallenAblehnen.grund ?? undefined}
        />
      )}
      <AktionsKnopf
        action={l.binden(entfallenFreigebenAction)}
        className="btn-primary text-xs py-1"
        disabled={!r.entfallenFreigeben.erlaubt}
        title={r.entfallenFreigeben.grund ?? 'Als zweite Person freigeben'}
        rueckfrage={{
          titel: 'Entfallen freigeben',
          text: 'Entfallen freigeben? Die Durchführung zählt dann nicht als „ohne Befund“.',
          bestaetigen: 'Freigeben',
        }}
      >
        Entfallen freigeben
      </AktionsKnopf>
    </span>
  );
}

function EntfallenHinweise({ l }: { l: Lage }) {
  const { d, namen } = l;
  return (
    <>
      {l.offenerAntrag ? (
        <div className="alert-warning flex flex-wrap items-start justify-between gap-3">
          <Zeile icon={icon(Ban)}>
            <strong>Entfallen beantragt von {namen.name(d.entfallenVon)}:</strong>{' '}
            {d.entfallenBegruendung}
          </Zeile>
          {l.aktuell ? <AntragKnoepfe l={l} /> : null}
        </div>
      ) : null}
      {d.status === 'ENTFALLEN' ? (
        <div className="alert-info-sm">
          <Zeile icon={icon(Ban)}>
            <strong>Entfallen</strong> — {d.entfallenBegruendung} (beantragt von{' '}
            {namen.name(d.entfallenVon)}, freigegeben von {namen.name(d.entfallenFreigegebenVon)}
            {d.entfallenAm ? ` am ${isoDatumText(d.entfallenAm)}` : ''}). Zählt nicht als „ohne
            Befund“.
          </Zeile>
        </div>
      ) : null}
    </>
  );
}

function PrueferHinweise({ l }: { l: Lage }) {
  const { d, namen } = l;
  const k = d.kontrolle;
  const gzm = k.gegenzeichnungMandant;
  if (d.status !== 'ZUR_GEGENZEICHNUNG') return null;
  const istPruefer = d.rechte.gegenzeichnen.erlaubt || d.rechte.zurueckweisen.erlaubt;
  return (
    <>
      {gzm && !d.mandantBestaetigtVon ? (
        <div className="alert-info-sm">
          <Zeile icon={icon(Users)}>
            Übermittelt vom Mandanten. Vor der Gegenzeichnung bestätigt eine zweite Person beim
            Mandanten die Vollständigkeit (vorgesehen: {namen.name(k.gegenzeichnerId)}).
          </Zeile>
        </div>
      ) : null}
      {istPruefer ? (
        <div className="alert-info-sm">
          <Zeile icon={icon(UserCheck)}>
            <strong>Prüferansicht — {namen.name(l.nutzerId)}.</strong> Sie prüfen die Einreichung
            von {namen.name(d.durchgefuehrtVon)}
            {gzm && d.mandantBestaetigtVon
              ? ` (bestätigt durch ${namen.name(d.mandantBestaetigtVon)})`
              : ''}{' '}
            und zeichnen gegen. Die durchführende Person kann nicht selbst gegenzeichnen.
          </Zeile>
        </div>
      ) : d.beteiligte.includes(l.nutzerId) ? (
        <div className="alert-info-sm">
          <Zeile icon={icon(Lock)}>
            Eingereicht — wartet auf Gegenzeichnung durch{' '}
            {gzm ? `die Kanzlei (${l.bt})` : namen.name(k.gegenzeichnerId)}. Die Nachweise sind
            gesperrt; Sie können nicht selbst gegenzeichnen.
          </Zeile>
        </div>
      ) : null}
    </>
  );
}

function HistorischHinweis({ d }: { d: DurchfuehrungDetail }) {
  if (!d.historisch) return null;
  return (
    <p className="text-xs text-muted">
      {d.begonnenAm
        ? 'Status, Nachweise, Verlauf und Personenbelege beziehen sich auf den Stichtag. Checkliste, Werte und Ergebnis zeigen die zuletzt gespeicherte Fassung (Zwischenstände werden nicht versioniert).'
        : 'Zum Stichtag war die Durchführung noch nicht begonnen; Checkliste, Werte und Ergebnis sind daher leer.'}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Hauptspalte: Editor mit Nachweisen und Ergebnis
// ---------------------------------------------------------------------------

function voraussetzungen(d: DurchfuehrungDetail): { ok: boolean; text: string }[] {
  const p = d.pruefung;
  const liste = [
    {
      ok: p.schritteErledigt === p.schritteGesamt,
      text: `Schritte ${p.schritteErledigt}/${p.schritteGesamt}`,
    },
  ];
  if (d.kontrolle.kennzahlen.length > 0) {
    liste.push({
      ok: p.werteFehlend.length === 0,
      text: p.werteFehlend.length ? `${p.werteFehlend.length} Werte offen` : 'Werte vollständig',
    });
  }
  if (p.ausserhalb.length > 0) {
    liste.push({
      ok: d.ergebnis === 'MIT_BEFUND',
      text: `Toleranz: ${p.ausserhalb.length} nicht erklärt`,
    });
  }
  liste.push({
    ok: p.nachweise >= p.mindestNachweise,
    text: `Nachweise ${p.nachweise}/${p.mindestNachweise}`,
  });
  const ergebnisText = !p.ergebnis
    ? 'Ergebnis offen'
    : p.kommentarFehlt
      ? 'Befund beschreiben'
      : 'Ergebnis gewählt';
  liste.push({ ok: !!p.ergebnis && !p.kommentarFehlt, text: ergebnisText });
  return liste;
}

function ErgebnisZusatz({ l }: { l: Lage }) {
  const { d } = l;
  return (
    <>
      {d.feststellungen.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {d.feststellungen.map((f) => (
            <li key={f.id}>
              <Link
                href={l.mitStand(`${l.basis}/feststellungen/${encodeURIComponent(f.id)}`)}
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <FileCheck className="h-3.5 w-3.5" aria-hidden="true" /> Verknüpfte Feststellung{' '}
                <FeststellungBezeichnung f={f} />
              </Link>
            </li>
          ))}
        </ul>
      ) : d.status === 'ZUR_GEGENZEICHNUNG' && d.ergebnis === 'MIT_BEFUND' ? (
        <p className="hint mt-2">
          Die verknüpfte Feststellung wird bei der Gegenzeichnung erfasst.
        </p>
      ) : null}
      {l.bearbeitbar ? (
        <div className="mt-3 border-t border-default pt-2.5">
          <p className="label-sm">Voraussetzungen für das Einreichen (gespeicherter Stand)</p>
          <ul className="flex flex-wrap gap-x-3.5 gap-y-1">
            {voraussetzungen(d).map((x) => (
              <li key={x.text} className="inline-flex items-center gap-1 text-xs">
                {x.ok ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                ) : (
                  <Circle className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                )}
                <span className="sr-only">{x.ok ? 'erfüllt: ' : 'offen: '}</span>
                <span className={x.ok ? 'text-primary' : 'text-muted'}>{x.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function gesperrtText({ d, abgeschlossen }: Lage): string {
  if (d.historisch) return 'Historischer Stand — nur Lesen';
  if (d.status === 'ZUR_GEGENZEICHNUNG') return 'Nach Einreichung gesperrt';
  if (abgeschlossen) return 'Abgeschlossen — Nachweise gesperrt und unveränderlich';
  if (d.status === 'ENTFALLEN') return 'Entfallen — keine Uploads';
  if (d.status === 'GEPLANT' && d.rechte.beginnen.erlaubt)
    return 'Upload nach Beginn der Durchführung';
  return d.rechte.bearbeiten.grund ?? 'Upload nicht möglich';
}

function Hauptspalte({
  l,
  kanzlei,
  anhaengbar,
}: {
  l: Lage;
  kanzlei: DurchfuehrungKanzleiDaten;
  anhaengbar: boolean;
}) {
  const { d } = l;
  const k = d.kontrolle;
  // Zum Stichtag noch nicht begonnen: keine Inhalte (wie die Demo).
  const leer = d.historisch && !d.begonnenAm;
  const schritte = leer
    ? d.schritte.map((s) => ({ ...s, erledigt: false, kommentar: '' }))
    : d.schritte;
  const werte = leer ? [] : d.werte;
  const ergebnis = leer ? null : d.ergebnis;
  const kommentar = leer ? null : d.ergebnisKommentar;
  const maxBytes = MAX_UPLOAD_BYTES_BY_KIND.tcmsNachweis;
  const mandant = encodeURIComponent(d.mandantId);
  return (
    <DurchfuehrungEditor
      key={JSON.stringify([d.stand, l.bearbeitbar, schritte, werte, ergebnis, kommentar])}
      formId={FORM_ID}
      bearbeitbar={l.bearbeitbar}
      sperrGrund={l.bearbeitbar ? null : d.rechte.bearbeiten.grund}
      schritte={schritte}
      kennzahlen={k.kennzahlen}
      werte={werteAusListe(werte)}
      toleranzEur={k.toleranzEur}
      periodeKurz={periodeKurz(d.periodeLabel)}
      ergebnis={ergebnis}
      ergebnisKommentar={kommentar}
      minBefund={DF_MIN_BEFUND_KOMMENTAR}
      ergebnisZusatz={<ErgebnisZusatz l={l} />}
      nachweise={
        <NachweiseKarte
          d={d}
          namen={l.namen}
          abgleich={kanzlei.abgleich}
          downloadHref={(n) =>
            `/api/staff/clients/${mandant}/tcms/nachweise/${encodeURIComponent(n)}`
          }
          bedienung={{
            erlaubt: anhaengbar,
            hochladen: l.binden(nachweisHochladenAction),
            auswaehlen: l.binden(nachweisAuswaehlenAction),
            entfernen: l.binden(nachweisEntfernenAction),
            dokumente: kanzlei.dokumente.map((x) => ({
              id: x.id,
              titel: x.titel,
              groesse: x.groesse,
              erstellt: isoDatumText(x.erstelltAm),
            })),
            maxBytes,
            maxText: formatUploadLimit(maxBytes),
          }}
          gesperrtText={gesperrtText(l)}
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Fußleiste je Status
// ---------------------------------------------------------------------------

function EntfallenDialog({ l }: { l: Lage }) {
  const r = l.d.rechte;
  if (!l.aktuell || !OFFEN.includes(l.d.status) || l.offenerAntrag) return null;
  return (
    <BegruendungsDialog
      ausloeser={
        <>
          <Ban className="h-4 w-4" aria-hidden="true" /> Entfallen beantragen …
        </>
      }
      titel="Entfallen beantragen"
      hinweis="Nur mit Begründung, z. B. keine Umsätze im Zeitraum. Eine entfallene Durchführung zählt nicht als „ohne Befund“. Die Freigabe erteilt eine zweite Person (Berufsträger:in)."
      action={l.binden(entfallenBeantragenAction)}
      bestaetigen="Antrag stellen"
      disabled={!r.entfallenBeantragen.erlaubt}
      disabledGrund={r.entfallenBeantragen.grund ?? undefined}
    />
  );
}

function FussGesperrt({ l }: { l: Lage }) {
  const grund = l.d.rechte.bearbeiten.grund ?? undefined;
  return (
    <div className="form-actions flex-wrap items-start">
      <EntfallenDialog l={l} />
      <button
        type="button"
        className="btn-secondary inline-flex items-center gap-1.5"
        disabled
        title={grund}
      >
        <Save className="h-4 w-4" aria-hidden="true" /> Entwurf speichern
      </button>
      <button
        type="button"
        className="btn-primary inline-flex items-center gap-1.5"
        disabled
        title={grund}
      >
        <Send className="h-4 w-4" aria-hidden="true" /> Zur Gegenzeichnung einreichen
      </button>
      {grund ? <span className="sr-only">{grund}</span> : null}
    </div>
  );
}

function FussGegenzeichnung({ l }: { l: Lage }) {
  const { d } = l;
  const r = d.rechte;
  const befundOhneFeststellung = d.ergebnis === 'MIT_BEFUND' && d.feststellungen.length === 0;
  return (
    <div className="form-actions flex-wrap items-start">
      <button
        type="button"
        className="btn-secondary inline-flex items-center gap-1.5"
        disabled
        title="Einreichung liegt vor — keine Änderung mehr möglich"
      >
        <Save className="h-4 w-4" aria-hidden="true" /> Entwurf speichern
      </button>
      <BegruendungsDialog
        ausloeser={
          <>
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> Zurückweisen …
          </>
        }
        ausloeserClass="btn-danger-outline"
        titel="Durchführung zurückweisen"
        hinweis="Die durchführende Person erhält die Begründung und kann die Angaben überarbeiten. Die Nachweise werden dafür wieder entsperrt; die eingereichte Fassung bleibt im Audit-Protokoll mit Hashes belegt."
        action={l.binden(durchfuehrungZurueckweisenAction)}
        bestaetigen="Zurückweisen"
        vierAugen={false}
        gefahr
        disabled={!r.zurueckweisen.erlaubt}
        disabledGrund={r.zurueckweisen.grund ?? undefined}
      />
      {befundOhneFeststellung ? (
        <GegenzeichnenMitBefundDialog
          action={l.binden(durchfuehrungGegenzeichnenAction)}
          disabled={!r.gegenzeichnen.erlaubt}
          title={r.gegenzeichnen.grund ?? 'Feststellung inline erfassen und gegenzeichnen'}
          risiken={d.risiken}
          vorschlagTitel={`${d.kontrolle.titel} ${d.periodeLabel}: Befund`}
          vorschlagSachverhalt={d.ergebnisKommentar ?? ''}
        />
      ) : (
        <AktionsKnopf
          action={l.binden(durchfuehrungGegenzeichnenAction)}
          disabled={!r.gegenzeichnen.erlaubt}
          title={
            r.gegenzeichnen.grund ?? 'Gegenzeichnung durch eine zweite Person (Vier-Augen-Prinzip)'
          }
          rueckfrage={{
            titel: 'Gegenzeichnen',
            text: `Durchführung gegenzeichnen – abgeschlossen ${d.ergebnis === 'MIT_BEFUND' ? 'mit' : 'ohne'} Befund?`,
            bestaetigen: 'Gegenzeichnen',
          }}
        >
          <UserCheck className="h-4 w-4" aria-hidden="true" /> Gegenzeichnen
        </AktionsKnopf>
      )}
    </div>
  );
}

function FussAbgeschlossen({ l }: { l: Lage }) {
  const r = l.d.rechte;
  return (
    <div className="form-actions flex-wrap items-start">
      <span className="text-xs text-muted grow text-right">
        Abgeschlossene Durchführungen sind unveränderlich; Korrekturen entstehen als verknüpfter
        Nachtrag.
      </span>
      <BegruendungsDialog
        ausloeser={
          <>
            <Plus className="h-4 w-4" aria-hidden="true" /> Nachtrag anlegen …
          </>
        }
        titel="Nachtrag anlegen"
        hinweis="Der Nachtrag ist eine eigene, verknüpfte Durchführung derselben Periode und Kontrollversion. Die abgeschlossene Durchführung bleibt unverändert."
        action={l.binden(nachtragAnlegenAction)}
        bestaetigen="Nachtrag anlegen"
        vierAugen={false}
        disabled={!r.nachtrag.erlaubt}
        disabledGrund={r.nachtrag.grund ?? undefined}
      />
    </div>
  );
}

function Fussleiste({ l }: { l: Lage }) {
  const { d } = l;
  if (!l.aktuell) {
    return (
      <p className="text-xs text-muted text-right">
        Historischer Stand – nur Lesen. Handlungen sind nur im aktuellen Stand möglich.
      </p>
    );
  }
  if (l.bearbeitbar) {
    return (
      <EntwurfFormular
        action={l.binden(durchfuehrungSpeichernAction)}
        formId={FORM_ID}
        einreichen="Zur Gegenzeichnung einreichen"
        links={<EntfallenDialog l={l} />}
      />
    );
  }
  if (d.status === 'GEPLANT') {
    return (
      <div className="form-actions flex-wrap items-start">
        <EntfallenDialog l={l} />
        <AktionsKnopf
          action={l.binden(durchfuehrungBeginnenAction)}
          disabled={!d.rechte.beginnen.erlaubt}
          title={d.rechte.beginnen.grund ?? 'Status wechselt zu „In Durchführung“'}
        >
          <CircleDot className="h-4 w-4" aria-hidden="true" /> Durchführung beginnen
        </AktionsKnopf>
      </div>
    );
  }
  if (d.status === 'IN_DURCHFUEHRUNG' || d.status === 'ZURUECKGEWIESEN') {
    return <FussGesperrt l={l} />;
  }
  if (d.status === 'ZUR_GEGENZEICHNUNG') return <FussGegenzeichnung l={l} />;
  if (l.abgeschlossen) return <FussAbgeschlossen l={l} />;
  return null;
}
