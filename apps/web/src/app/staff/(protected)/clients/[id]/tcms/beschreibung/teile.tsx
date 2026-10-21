// =============================================================================
// Teile der Seite „CMS-Beschreibung“ (TCMS Stufe 3, Bereich A): Status-
// aktionen, Hinweise, Gliederung, Abschnitt, Versionen, eingefrorener Inhalt
// und Freigabeverlauf. Reine Darstellung des Modells aus page.tsx; Aktionen
// laufen über die Server-Actions in ./actions.ts.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  Ban,
  CheckCheck,
  CheckCircle2,
  FileCheck,
  FileText,
  Lock,
  MailCheck,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  TriangleAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  REVIEW_MIN_BEGRUENDUNG,
  type BeschreibungAbschnitt,
  type BeschreibungView,
} from '@taxtronik/tcms-contract';
import {
  ABSCHNITTE,
  abschnittHatText,
  BAUSTEIN_LABEL,
  type AbschnittVorlage,
} from '@taxtronik/tcms-domain';
import { HashKurz } from '@/components/tcms/badges';
import { alsDatum, isoDatumText, isoZeitText } from '@/components/tcms/format';
import {
  AbschnittAnsicht,
  abschnittFuer,
  BausteinBlock,
  type BausteinQuelle,
  BeschreibungFassung,
  BeschreibungStatusBadge,
} from '@/components/tcms/programm/beschreibung';
import { TcmsAktionsDialog } from '@/components/tcms/programm/dialog';
import { TcmsKnopfAktion } from '@/components/tcms/programm/knopf';
import {
  einzigerEmpfaenger,
  empfaengerLabel,
  KEIN_EMPFAENGER_MIT_PORTALZUGANG,
  type Empfaenger,
} from '@/components/tcms/empfaenger';
import { zustellungGescheitert, ZustellungAnzeige } from '@/components/tcms/zustellung';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import {
  freigabeAnfordernAction,
  reviewAbschliessenAction,
  reviewZurueckweisenAction,
  versionAnlegenAction,
  zurReviewAction,
} from './actions';
import { AbschnittEditor } from './editor';
import { TCMS_TEXT_ISOLIERT } from '@/components/tcms/text';

export type Version = BeschreibungView['versionen'][number];
type Freigabe = BeschreibungView['freigaben'][number];

export const NUR_AKTUELL = 'Nur im aktuellen Stand möglich.';
const ANFORDERN_ERST =
  'Die Freigabe beim Mandanten lässt sich erst nach abgeschlossener Kanzlei-Review anfordern.';
const KEINE_GV =
  'Für diesen Mandanten ist im Tax-CMS keine gesetzliche Vertretung hinterlegt (Kontakte & Rollen).';

export interface HrefOptionen {
  version?: string;
  abschnitt?: string;
  bearbeiten?: boolean;
}

/** Alles, was die Teile der Seite brauchen (aus der Antwort und der kanzleikonsole). */
export interface BeschreibungModell {
  mandantId: string;
  basis: string;
  b: BeschreibungView;
  v: Version;
  aktuell: Version;
  gesamt: boolean;
  vorlage: AbschnittVorlage;
  eingefroren: boolean;
  abschnitte: readonly BeschreibungAbschnitt[];
  abschnitt: BeschreibungAbschnitt;
  quelle: BausteinQuelle;
  bearbeitbar: boolean;
  bearbeitenGrund: string | null;
  bearbeiten: boolean;
  offeneFreigabe: Freigabe | null;
  /**
   * Gesetzliche Vertretungen: Kontakte dieses Mandanten mit Rolle im Tax-CMS,
   * mit Kennzeichen für den aktiven Portalzugang (kk-tcms-s11).
   */
  gv: readonly Empfaenger[];
  /** Personen-ID der angemeldeten Person (klein). */
  me: string;
  name: (id: string | null) => string;
  href: (o: HrefOptionen) => string;
}

/** Abschnitt zur Vorlage (gemeinsam mit der Fassung im Portal). */
export { abschnittFuer };

const titelVon = (a: AbschnittVorlage) =>
  a.nr === 'A' ? 'Anhang' : `Abschnitt ${a.nr} – ${a.titel}`;
const kurzVon = (a: AbschnittVorlage) => (a.nr === 'A' ? 'Anhang' : `Abschnitt ${a.nr}`);

function grundOhneRecht(b: BeschreibungView): string {
  return b.historisch ? NUR_AKTUELL : TCMS_KEIN_RECHT.BEARBEITEN;
}

// ---------------------------------------------------------------------------
// Neue Version
// ---------------------------------------------------------------------------

export function NeueVersion({
  mandantId,
  b,
  text,
  klasse,
}: {
  mandantId: string;
  b: BeschreibungView;
  text: string;
  klasse: string;
}) {
  const offen = b.versionen.find((x) => x.status === 'ENTWURF' || x.status === 'KANZLEI_REVIEW');
  const grund = !b.darfBearbeiten
    ? grundOhneRecht(b)
    : offen
      ? `Version ${offen.nummer} ist noch in Bearbeitung.`
      : null;
  return (
    <TcmsKnopfAktion
      aktion={versionAnlegenAction.bind(null, mandantId)}
      knopfKlasse={klasse}
      erfolg="Version angelegt."
      deaktiviert={grund !== null}
      {...(grund ? { deaktiviertGrund: grund } : {})}
    >
      <Plus className="h-4 w-4" aria-hidden="true" /> {text}
    </TcmsKnopfAktion>
  );
}

// ---------------------------------------------------------------------------
// Statusaktionen
// ---------------------------------------------------------------------------

function ZurueckDialog({ m }: { m: BeschreibungModell }) {
  const darf = m.b.darfBearbeiten;
  return (
    <TcmsAktionsDialog
      ausloeser={
        <>
          <RotateCcw className="h-4 w-4" aria-hidden="true" /> Zurück in den Entwurf
        </>
      }
      titel={`Version ${m.v.nummer} zurück in den Entwurf`}
      beschreibung={
        <p>
          Die Kanzlei-Review endet; der Entwurf kann wieder bearbeitet werden. Die Begründung wird
          mit Name und Zeitpunkt protokolliert.
        </p>
      }
      bestaetigen="Zurückgeben"
      gefahr
      aktion={reviewZurueckweisenAction.bind(null, m.mandantId)}
      versteckt={{ versionId: m.v.id }}
      erfolg="Die Version ist zurück im Entwurf."
      deaktiviert={!darf}
      {...(!darf ? { deaktiviertGrund: grundOhneRecht(m.b) } : {})}
      fieldIds={{ begruendung: 'beschreibung-zurueck-begruendung' }}
    >
      <div>
        <label className="label" htmlFor="beschreibung-zurueck-begruendung">
          Begründung (mindestens {REVIEW_MIN_BEGRUENDUNG} Zeichen)
        </label>
        <textarea
          {...TCMS_TEXT_ISOLIERT}
          id="beschreibung-zurueck-begruendung"
          name="begruendung"
          className="input"
          rows={4}
          minLength={REVIEW_MIN_BEGRUENDUNG}
          maxLength={2000}
          required
        />
      </div>
    </TcmsAktionsDialog>
  );
}

function ReviewAbschliessen({ m }: { m: BeschreibungModell }) {
  const selbst = m.v.letzteBearbeitung !== null && m.v.letzteBearbeitung.toLowerCase() === m.me;
  // Anzeige: Wer zuletzt bearbeitet hat, bekommt den Abschluss nicht angeboten;
  // entscheidend bleibt der Dienst (Vier-Augen-Prinzip unter Zeilensperre).
  const grund = !m.b.darfBearbeiten
    ? grundOhneRecht(m.b)
    : selbst
      ? 'Die Review schließt eine zweite Person ab – Sie haben den Text zuletzt bearbeitet.'
      : undefined;
  return (
    <TcmsKnopfAktion
      aktion={reviewAbschliessenAction.bind(null, m.mandantId)}
      versteckt={{ versionId: m.v.id }}
      erfolg="Kanzlei-Review abgeschlossen."
      deaktiviert={grund !== undefined}
      {...(grund ? { deaktiviertGrund: grund } : {})}
      titel="Vier-Augen-Prinzip: Eine zweite Person bestätigt den Entwurf."
    >
      <FileCheck className="h-4 w-4" aria-hidden="true" /> Review abschließen
    </TcmsKnopfAktion>
  );
}

function FreigabeAnfordern({ m }: { m: BeschreibungModell }) {
  const andere = m.b.versionen.filter((x) => x.status === 'BEIM_MANDANTEN' && x.id !== m.v.id);
  const grund = !m.b.darfBearbeiten
    ? grundOhneRecht(m.b)
    : m.gv.length === 0
      ? KEINE_GV
      : m.gv.every((p) => !p.portal)
        ? KEIN_EMPFAENGER_MIT_PORTALZUGANG
        : null;
  const vorauswahl = einzigerEmpfaenger(m.gv);
  return (
    <TcmsAktionsDialog
      ausloeser={
        <>
          <Send className="h-4 w-4" aria-hidden="true" /> Freigabe beim Mandanten anfordern
        </>
      }
      ausloeserKlasse="btn-primary"
      titel={`Freigabe von Version ${m.v.nummer} anfordern`}
      beschreibung={
        <>
          <p>
            Der Inhalt der Version wird eingefroren und mit SHA-256 gebunden; danach ist er
            unveränderlich. Änderungen entstehen als neue Version.
          </p>
          <p>
            Die gewählte gesetzliche Vertretung erhält einen Bestätigungscode über den Postausgang
            und gibt im Mandanten-Portal frei.
          </p>
          {andere.length ? (
            <p className="font-medium">
              Die offene Anforderung für Version {andere.map((x) => x.nummer).join(', ')} wird
              zurückgezogen.
            </p>
          ) : null}
        </>
      }
      bestaetigen="Einfrieren und anfordern"
      aktion={freigabeAnfordernAction.bind(null, m.mandantId)}
      versteckt={{ versionId: m.v.id }}
      erfolg="Freigabe angefordert."
      deaktiviert={grund !== null}
      {...(grund ? { deaktiviertGrund: grund } : {})}
      fieldIds={{ empfaengerId: 'beschreibung-empfaenger' }}
    >
      <div>
        <label className="label" htmlFor="beschreibung-empfaenger">
          Empfänger (gesetzliche Vertretung)
        </label>
        <select
          id="beschreibung-empfaenger"
          name="empfaengerId"
          className="input"
          defaultValue={vorauswahl}
          required
        >
          {vorauswahl === '' ? <option value="">Bitte wählen …</option> : null}
          {m.gv.map((p) => (
            <option {...TCMS_TEXT_ISOLIERT} key={p.id} value={p.id} disabled={!p.portal}>
              {empfaengerLabel(p.name, p.portal)}
            </option>
          ))}
        </select>
      </div>
    </TcmsAktionsDialog>
  );
}

function Endstatus({ v }: { v: Version }) {
  if (v.status === 'BEIM_MANDANTEN') {
    return (
      <span className="badge-yellow gap-1">
        <MailCheck className="h-3.5 w-3.5" aria-hidden="true" /> wartet auf Freigabe durch den
        Mandanten
      </span>
    );
  }
  const frei = v.status === 'FREIGEGEBEN';
  return (
    <span className={`${frei ? 'badge-green' : 'badge-gray'} gap-1`}>
      <Lock className="h-3.5 w-3.5" aria-hidden="true" />
      {frei ? 'freigegeben – unveränderlich' : 'abgelöst – unveränderlich'}
    </span>
  );
}

/** Aktionen je Status der angezeigten Version (Rechte entscheidet der Dienst). */
export function Statusaktionen({ m }: { m: BeschreibungModell }) {
  const { b, v } = m;
  if (b.historisch || v.anzeige !== v.status) {
    return <span className="badge-gray">Stand zum Stichtag – nur Lesen</span>;
  }
  if (v.status === 'ENTWURF') {
    return (
      <>
        <TcmsKnopfAktion
          aktion={zurReviewAction.bind(null, m.mandantId)}
          versteckt={{ versionId: v.id }}
          erfolg="Zur Kanzlei-Review eingereicht."
          deaktiviert={!b.darfBearbeiten}
          {...(!b.darfBearbeiten ? { deaktiviertGrund: grundOhneRecht(b) } : {})}
        >
          <Send className="h-4 w-4" aria-hidden="true" /> Zur Kanzlei-Review einreichen
        </TcmsKnopfAktion>
        <p className="text-xs text-muted max-w-xs">{ANFORDERN_ERST}</p>
      </>
    );
  }
  if (v.status !== 'KANZLEI_REVIEW') return <Endstatus v={v} />;
  return (
    <>
      <ZurueckDialog m={m} />
      {v.reviewVon ? (
        <FreigabeAnfordern m={m} />
      ) : (
        <>
          <ReviewAbschliessen m={m} />
          <p className="text-xs text-muted max-w-xs">{ANFORDERN_ERST}</p>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Hinweise unter dem Kopf
// ---------------------------------------------------------------------------

function codeHinweis(f: Freigabe | null): string {
  switch (f?.codeStatus) {
    case 'AKTIV':
      return `Bestätigung per E-Mail-Code, gültig bis ${isoDatumText(f.codeAblauf)}.`;
    case 'ABGELAUFEN':
      return 'Der Bestätigungscode ist abgelaufen; die gesetzliche Vertretung fordert im Portal einen neuen an.';
    case 'GESPERRT':
      return 'Zu viele Fehlversuche – der Code ist gesperrt. Eine Neuadressierung setzt Code und Fehlversuche zurück.';
    default:
      return 'Ein Bestätigungscode ist noch nicht versandt; die gesetzliche Vertretung fordert ihn im Portal an.';
  }
}

export function Hinweise({ m }: { m: BeschreibungModell }) {
  const { v, b, offeneFreigabe: f } = m;
  const gescheitert = zustellungGescheitert(f?.zustellung);
  if (v.anzeige === 'BEIM_MANDANTEN') {
    return (
      <div className="alert-info mt-3 flex items-start gap-2" role="note">
        <MailCheck className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          <strong>
            Zur Freigabe bei {f ? m.name(f.empfaengerId) : 'der gesetzlichen Vertretung'}
          </strong>{' '}
          seit {isoZeitText(v.freigabeAngefordertAm)}. {codeHinweis(f)}{' '}
          {m.eingefroren
            ? 'Angezeigt wird der zur Freigabe vorgelegte, eingefrorene Inhalt.'
            : 'Für diese Version liegt noch kein eingefrorener Inhalt vor.'}{' '}
          {f && gescheitert ? (
            <strong>Die gesetzliche Vertretung hat die Anforderung nicht erhalten. </strong>
          ) : null}
          {f && b.darfBearbeiten ? (
            <Link className="underline" href={`${m.basis}/kommunikation`}>
              {gescheitert ? 'Neu adressieren (Kommunikation)' : 'Empfänger ändern (Kommunikation)'}
            </Link>
          ) : null}
          {f ? <ZustellungAnzeige zustellung={f.zustellung} /> : null}
        </span>
      </div>
    );
  }
  if (v.anzeige === 'KANZLEI_REVIEW' && v.reviewVon && !b.historisch) {
    return (
      <p className="alert-success mt-3 text-sm" role="note">
        Kanzlei-Review abgeschlossen · {m.name(v.reviewVon)} · {isoZeitText(v.reviewAm)}. Die
        Freigabe beim Mandanten kann angefordert werden.
      </p>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gliederung
// ---------------------------------------------------------------------------

function navKlasse(aktiv: boolean): string {
  return `flex items-center gap-2 rounded px-2 py-1.5 text-sm ${aktiv ? 'bg-surface-raised font-semibold text-primary' : 'text-secondary hover:bg-surface-raised'}`;
}

function GliederungsEintrag({ m, a }: { m: BeschreibungModell; a: AbschnittVorlage }) {
  const ab = abschnittFuer(m.abschnitte, a.key);
  const aktiv = !m.gesamt && a.key === m.vorlage.key;
  return (
    <li>
      <Link
        href={m.href({ abschnitt: a.key })}
        aria-current={aktiv ? 'true' : undefined}
        className={navKlasse(aktiv)}
      >
        {a.nr !== 'A' ? <span className="w-4 font-mono text-muted">{a.nr}</span> : null}
        <span className="grow">{a.nr === 'A' ? 'Anhang' : a.titel}</span>
        {!abschnittHatText(ab) ? (
          <span className="status-dot dot-amber" title="Kein Freitext – Lücke">
            <span className="sr-only">(Lücke)</span>
          </span>
        ) : null}
      </Link>
      {a.key === 'anhang' ? (
        <p className="text-xs text-muted px-2 pb-1">
          {ab.bloecke
            .flatMap((x) => (x.typ === 'baustein' ? [BAUSTEIN_LABEL[x.art]] : []))
            .join(' · ') || 'ohne Bausteine'}
        </p>
      ) : null}
    </li>
  );
}

export function Gliederung({ m }: { m: BeschreibungModell }) {
  const luecken = ABSCHNITTE.filter((a) => !abschnittHatText(abschnittFuer(m.abschnitte, a.key)));
  return (
    <nav className="card p-3 xl:col-span-3" aria-label="Gliederung der CMS-Beschreibung">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Inhalt</p>
      <ul className="space-y-0.5">
        {ABSCHNITTE.map((a) => (
          <GliederungsEintrag key={a.key} m={m} a={a} />
        ))}
        <li>
          <Link
            href={m.href({ abschnitt: 'alle' })}
            aria-current={m.gesamt ? 'true' : undefined}
            className={`mt-1 ${navKlasse(m.gesamt)}`}
          >
            <FileText className="h-4 w-4" aria-hidden="true" /> Gesamtansicht
          </Link>
        </li>
      </ul>
      <p className="mt-3 border-t border-default pt-2 text-xs">
        {luecken.length ? (
          <span className="badge-yellow" title={luecken.map((l) => l.titel).join('\n')}>
            Lücken ({luecken.length})
          </span>
        ) : (
          <span className="text-muted">alle Abschnitte mit Freitext dokumentiert</span>
        )}
      </p>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Abschnitt (Lesen, Bearbeiten, Gesamtansicht)
// ---------------------------------------------------------------------------

function KopfAktion({ m }: { m: BeschreibungModell }) {
  if (m.gesamt) return null;
  if (m.bearbeiten) {
    return (
      <span className="badge-brand gap-1">
        <Pencil className="h-3 w-3" aria-hidden="true" /> Bearbeitung
      </span>
    );
  }
  if (m.bearbeitbar) {
    return (
      <Link href={m.href({ bearbeiten: true })} className="btn-secondary text-xs py-1">
        <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Bearbeiten
      </Link>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      {m.eingefroren ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      {m.bearbeitenGrund}
    </span>
  );
}

function Inhalt({ m }: { m: BeschreibungModell }) {
  if (m.gesamt) {
    return <BeschreibungFassung abschnitte={m.abschnitte} quelle={m.quelle} />;
  }
  if (!m.bearbeiten) {
    return <AbschnittAnsicht abschnitt={m.abschnitt} vorlage={m.vorlage} quelle={m.quelle} />;
  }
  const bausteine: Record<string, ReactNode> = {};
  for (const x of m.abschnitt.bloecke) {
    if (x.typ === 'baustein') bausteine[x.art] = <BausteinBlock art={x.art} quelle={m.quelle} />;
  }
  return (
    <AbschnittEditor
      key={`${m.v.id}-${m.abschnitt.key}`}
      mandantId={m.mandantId}
      versionId={m.v.id}
      abschnitt={m.abschnitt}
      titel={titelVon(m.vorlage)}
      bausteine={bausteine}
      fertigHref={m.href({})}
    />
  );
}

function fussText(m: BeschreibungModell): string {
  const basis = m.eingefroren
    ? `Eingefrorener Inhalt v${m.v.nummer} – unveränderlich. Änderungen entstehen als neue Version.`
    : m.v.status === 'ENTWURF'
      ? `Änderungen werden in v${m.v.nummer} gespeichert und protokolliert.`
      : 'Änderungen erzeugen eine neue Version.';
  return m.b.historisch && !m.eingefroren
    ? `${basis} Freitext im aktuellen Bearbeitungsstand; Entwürfe werden nicht je Tag versioniert.`
    : basis;
}

function Blaettern({ m }: { m: BeschreibungModell }) {
  if (m.gesamt) return null;
  const pos = ABSCHNITTE.findIndex((a) => a.key === m.vorlage.key);
  const vorige = pos > 0 ? ABSCHNITTE[pos - 1] : undefined;
  const naechste = ABSCHNITTE[pos + 1];
  return (
    <span className="flex gap-3">
      {vorige ? (
        <Link href={m.href({ abschnitt: vorige.key })} className="underline">
          ← {kurzVon(vorige)}
        </Link>
      ) : null}
      {naechste ? (
        <Link href={m.href({ abschnitt: naechste.key })} className="underline">
          {kurzVon(naechste)} →
        </Link>
      ) : null}
    </span>
  );
}

export function AbschnittKarte({ m }: { m: BeschreibungModell }) {
  return (
    <section className="card xl:col-span-6" aria-labelledby="beschreibung-abschnitt">
      <div className="card-header flex flex-wrap gap-2">
        <h3 id="beschreibung-abschnitt" className="text-sm font-semibold text-primary">
          {m.gesamt ? `Gesamtansicht Version ${m.v.nummer}` : titelVon(m.vorlage)}
        </h3>
        <KopfAktion m={m} />
      </div>
      <div className="p-4">
        <Inhalt m={m} />
      </div>
      <div className="card-footer flex flex-wrap justify-between gap-2">
        <span>{fussText(m)}</span>
        <Blaettern m={m} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Seitenleiste: Versionen, eingefrorener Inhalt, Verlauf
// ---------------------------------------------------------------------------

function versionsZeile(x: Version, name: (id: string | null) => string): string {
  if ((x.anzeige === 'FREIGEGEBEN' || x.anzeige === 'ABGELOEST') && x.freigegebenAm) {
    return `${isoDatumText(x.freigegebenAm)} · ${name(x.freigegebenVon)}`;
  }
  if (x.anzeige === 'BEIM_MANDANTEN' && x.freigabeAngefordertAm)
    return `angefordert ${isoDatumText(x.freigabeAngefordertAm)}`;
  if (x.anzeige === 'KANZLEI_REVIEW')
    return x.reviewVon
      ? `Review: ${name(x.reviewVon)} · ${isoDatumText(x.reviewAm)}`
      : `Review offen seit ${isoDatumText(x.reviewAngefordertAm)}`;
  if (x.anzeige === 'ABGELOEST') return `${isoDatumText(x.createdAt)} · zurückgezogen`;
  return `${isoDatumText(x.createdAt)} · ${name(x.erstelltVon)}`;
}

function VersionsEintrag({ m, x }: { m: BeschreibungModell; x: Version }) {
  const gewaehlt = x.id === m.v.id;
  return (
    <li className="border-t border-default">
      <Link
        href={m.href({ version: x.id, bearbeiten: false })}
        aria-current={gewaehlt ? 'true' : undefined}
        className={`flex items-start gap-2 px-4 py-2 ${gewaehlt ? 'bg-surface-raised' : 'hover:bg-surface-raised'}`}
      >
        <span className="grow">
          <span className="flex flex-wrap items-center gap-1.5">
            <span
              className={`text-sm font-bold font-mono ${x.anzeige === 'ABGELOEST' ? 'line-through' : ''}`}
            >
              v{x.nummer}
            </span>
            <BeschreibungStatusBadge status={x.anzeige} />
          </span>
          <span className="block text-xs text-muted mt-1">{versionsZeile(x, m.name)}</span>
        </span>
        {x.id === m.aktuell.id ? <span className="badge-brand shrink-0">aktuell</span> : null}
      </Link>
    </li>
  );
}

export function VersionenKarte({ m }: { m: BeschreibungModell }) {
  return (
    <section className="card" aria-labelledby="beschreibung-versionen">
      <div className="card-header">
        <h3 id="beschreibung-versionen" className="text-sm font-semibold text-primary">
          Versionen
        </h3>
      </div>
      <ul>
        {[...m.b.versionen].reverse().map((x) => (
          <VersionsEintrag key={x.id} m={m} x={x} />
        ))}
      </ul>
      <div className="card-footer flex flex-wrap items-center gap-2">
        <NeueVersion
          mandantId={m.mandantId}
          b={m.b}
          text="Neue Version anlegen"
          klasse="btn-secondary text-xs py-1"
        />
        <span className="text-xs">aus v{m.aktuell.nummer}</span>
      </div>
    </section>
  );
}

function HashPruefung({ geprueft }: { geprueft: boolean | null }) {
  if (geprueft === true) {
    return (
      <p className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Hash geprüft: Inhalt unverändert
      </p>
    );
  }
  if (geprueft === false) {
    return (
      <p className="flex items-center gap-1.5 text-red-700 dark:text-red-400" role="alert">
        <TriangleAlert className="h-4 w-4" aria-hidden="true" /> Hash weicht vom gespeicherten
        Inhalt ab
      </p>
    );
  }
  return null;
}

export function SnapshotKarte({ m }: { m: BeschreibungModell }) {
  const { v } = m;
  const snap = m.eingefroren ? v.snapshot : null;
  return (
    <section className="card" aria-labelledby="beschreibung-snapshot">
      <div className="card-header">
        <h3 id="beschreibung-snapshot" className="text-sm font-semibold text-primary">
          Eingefrorener Inhalt
        </h3>
        {snap && v.snapshotSha256 ? (
          <span className="badge-gray gap-1">
            <Lock className="h-3 w-3" aria-hidden="true" /> <HashKurz wert={v.snapshotSha256} />
          </span>
        ) : null}
      </div>
      <div className="p-4 space-y-1.5 text-sm">
        {snap ? (
          <>
            <HashPruefung geprueft={v.snapshotGeprueft} />
            <p className="text-xs text-muted">
              {snap.erzeugtAm
                ? `Eingefroren am ${isoZeitText(snap.erzeugtAm)}`
                : 'Eingefroren bei der Anforderung'}
              {snap.stand ? ` · Datenstand ${isoDatumText(snap.stand)}` : ''}
            </p>
            {v.snapshotSha256 ? (
              <p className="text-xs text-muted font-mono break-all">SHA-256 {v.snapshotSha256}</p>
            ) : null}
            <p className="text-xs text-muted">
              Ein Hash bindet Inhalte; er authentifiziert keine Person.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted">
            Lebende Bausteine zeigen den Stand {isoDatumText(m.b.stand)}. Beim Anfordern der
            Freigabe wird der Inhalt eingefroren und mit SHA-256 gebunden.
          </p>
        )}
      </div>
    </section>
  );
}

interface VerlaufEintrag {
  at: string;
  icon: LucideIcon;
  titel: string;
  unter: string;
}

function versionsSchritte(v: Version, name: (id: string | null) => string): VerlaufEintrag[] {
  const e: VerlaufEintrag[] = [];
  if (v.freigegebenAm)
    e.push({
      at: v.freigegebenAm,
      icon: CheckCheck,
      titel: `Freigabe v${v.nummer} durch ${name(v.freigegebenVon)}`,
      unter: `E-Mail-Code bestätigt · ${isoZeitText(v.freigegebenAm)}`,
    });
  if (v.freigabeAngefordertAm)
    e.push({
      at: v.freigabeAngefordertAm,
      icon: Send,
      titel: `Anforderung v${v.nummer} an den Mandanten`,
      unter: isoZeitText(v.freigabeAngefordertAm),
    });
  if (v.reviewAm)
    e.push({
      at: v.reviewAm,
      icon: FileCheck,
      titel: `Kanzlei-Review v${v.nummer} durch ${name(v.reviewVon)}`,
      unter: isoZeitText(v.reviewAm),
    });
  if (v.reviewAngefordertAm)
    e.push({
      at: v.reviewAngefordertAm,
      icon: Users,
      titel: `v${v.nummer} zur Kanzlei-Review`,
      unter: `${name(v.reviewAngefordertVon)} · ${isoZeitText(v.reviewAngefordertAm)}`,
    });
  return e;
}

/** Review- und Freigabeschritte über alle Versionen (neueste zuerst, Auswahl der Antwort). */
export function verlauf(
  b: BeschreibungView,
  name: (id: string | null) => string,
): VerlaufEintrag[] {
  const nr = new Map(b.versionen.map((v) => [v.id, v.nummer]));
  const e: VerlaufEintrag[] = b.versionen.flatMap((v) => versionsSchritte(v, name));
  for (const f of b.freigaben) {
    if (f.status !== 'ABGELEHNT' || !f.erledigtAm) continue;
    e.push({
      at: f.erledigtAm,
      icon: Ban,
      titel: `Anforderung v${nr.get(f.refId) ?? '?'} beendet`,
      unter: `${f.anmerkung ? `${f.anmerkung} · ` : ''}${isoZeitText(f.erledigtAm)}`,
    });
  }
  for (const z of b.zurueckweisungen) {
    e.push({
      at: z.at,
      icon: RotateCcw,
      titel: `v${z.nummer} zurück in den Entwurf`,
      unter: `${name(z.actorId)} · ${isoZeitText(z.at)}${z.begruendung ? ` · „${z.begruendung}“` : ''}`,
    });
  }
  const zeit = (iso: string) => alsDatum(iso)?.getTime() ?? 0;
  return e.sort((a, c) => zeit(c.at) - zeit(a.at)).slice(0, 8);
}

export function VerlaufKarte({ m }: { m: BeschreibungModell }) {
  const eintraege = verlauf(m.b, m.name);
  return (
    <section className="card" aria-labelledby="beschreibung-verlauf">
      <div className="card-header">
        <h3 id="beschreibung-verlauf" className="text-sm font-semibold text-primary">
          Freigabeverlauf
        </h3>
      </div>
      {eintraege.length === 0 ? (
        <p className="p-4 text-sm text-muted">Noch keine Review- oder Freigabeschritte.</p>
      ) : (
        <ol>
          {eintraege.map(({ icon: Icon, titel, unter }, i) => (
            <li key={i} className="flex items-start gap-3 border-t border-default px-4 py-2">
              <span className="kpi-chip chip-gray shrink-0" aria-hidden="true">
                <Icon className="h-4 w-4" />
              </span>
              <span className="grow">
                <span className="block text-sm font-medium">{titel}</span>
                <span className="block text-xs text-muted mt-0.5">{unter}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
