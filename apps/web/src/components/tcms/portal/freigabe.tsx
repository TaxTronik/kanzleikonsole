// =============================================================================
// Freigaben und Kenntnisnahmen im Portal (TCMS Stufe 3, Bereich D; aus der
// Demo components/portal/freigabe.tsx). Was die Person tun darf
// (`darfFreigeben`, `darfKenntnisnehmen`, `sperrgrund`) und den Zustand des
// Bestätigungscodes (nie den Code selbst) liefert das Tax-CMS; Namen kommen
// aus der kanzleikonsole. Codes fordert die Seite an (Zustellung per E-Mail
// über den Postausgang des Tax-CMS) und nimmt sie entgegen. Die vorgelegte
// Fassung einer Beschreibung zeigt die gemeinsame Darstellung aus Bereich A
// (`BeschreibungFassung`): eingefroren mit SHA-256, sonst lebend mit Namen aus
// der kanzleikonsole.
// =============================================================================

import { Ban, CheckCheck, FileText, Lock, Mail } from 'lucide-react';
import type { BausteinSatzDaten, PortalFreigabeView } from '@taxtronik/tcms-contract';
import { HashKurz } from '../badges';
import { isoDatumText, isoZeitText } from '../format';
import { TcmsAktionsKnopf, type TcmsFormAktion } from '../ereignisse/aktionen';
import { bausteinPersonIds, BeschreibungFassung } from '../programm/beschreibung';
import { FreigabeCodeFormular, KenntnisnahmeFormular } from './freigabe-formulare';
import { freigabeArtLabel } from './texte';

type Namen = { name(id: string | null | undefined): string };

export interface FreigabeAktionen {
  codeAnfordern: TcmsFormAktion;
  freigeben: TcmsFormAktion;
  kenntnisnehmen: TcmsFormAktion;
}

/** Zustand des Bestätigungscodes laut Dienst (nie der Code). */
function CodeStatus({ code }: { code: NonNullable<PortalFreigabeView['code']> }) {
  switch (code.status) {
    case 'GESPERRT':
      return (
        <p className="text-xs text-red-700 dark:text-red-400" role="status">
          Der Bestätigungscode ist nach mehreren Fehlversuchen gesperrt. Bitte wenden Sie sich an
          Ihre Kanzlei.
        </p>
      );
    case 'ABGELAUFEN':
      return (
        <p className="text-xs text-red-700 dark:text-red-400" role="status">
          Der Code ist {code.ablauf ? `am ${isoDatumText(code.ablauf)} ` : ''}abgelaufen. Bitte
          fordern Sie einen neuen an.
        </p>
      );
    case 'AKTIV':
      return (
        <p className="text-xs text-muted" role="status">
          Code an Sie gesendet{code.ablauf ? ` · gültig bis ${isoZeitText(code.ablauf)}` : ''} ·
          noch {code.verbleibendeVersuche}{' '}
          {code.verbleibendeVersuche === 1 ? 'Versuch' : 'Versuche'}
        </p>
      );
    default:
      return <p className="text-xs text-muted">Noch kein Bestätigungscode angefordert.</p>;
  }
}

function DokThumb() {
  return (
    <span className="kpi-chip chip-brand" aria-hidden="true">
      <FileText className="h-4 w-4" />
    </span>
  );
}

function Gesperrt({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-sm text-secondary">
      <Lock className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
      {text}
    </p>
  );
}

/** Freigabe mit Code: Code anfordern und eingeben, wenn der Dienst es erlaubt. */
function CodeBedienung({
  f,
  gvNamen,
  aktionen,
}: {
  f: PortalFreigabeView;
  gvNamen: string;
  aktionen: FreigabeAktionen;
}) {
  if (!f.darfFreigeben) {
    return (
      <Gesperrt
        text={
          f.sperrgrund ??
          `Freigaben sind der gesetzlichen Vertretung vorbehalten${gvNamen ? ` (${gvNamen})` : ''}.`
        }
      />
    );
  }
  const status = f.code?.status ?? 'KEIN';
  return (
    <div className="space-y-3">
      <p className="text-sm text-secondary">
        Mit der Freigabe bestätigen Sie als gesetzliche Vertretung die vorgelegte Fassung. Die
        Bestätigung erfolgt mit dem 6-stelligen Code aus Ihrer E-Mail.
      </p>
      {status === 'AKTIV' ? (
        <FreigabeCodeFormular aktion={aktionen.freigeben} freigabeTitel={f.titel} />
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-2">
        {f.code ? <CodeStatus code={f.code} /> : null}
        {status !== 'GESPERRT' ? (
          <TcmsAktionsKnopf
            aktion={aktionen.codeAnfordern}
            className={status === 'AKTIV' ? 'btn-secondary text-xs py-1' : 'btn-primary'}
          >
            <Mail className="h-4 w-4" aria-hidden="true" />{' '}
            {status === 'AKTIV' ? 'Code erneut senden' : 'Bestätigungscode per E-Mail anfordern'}
          </TcmsAktionsKnopf>
        ) : null}
      </div>
    </div>
  );
}

/** Inhalt der Anforderung: eingefrorene Fassung, aktuelle Fassung oder Text. */
function FreigabeDokument({
  f,
  live,
  namen,
}: {
  f: PortalFreigabeView;
  live: { stand: string; bausteine: BausteinSatzDaten } | null;
  namen: Namen;
}) {
  if (!f.version) return <p className="text-sm text-secondary whitespace-pre-wrap">{f.inhalt}</p>;
  const snapshot = f.version.snapshot;
  const idPraefix = `freigabe-${f.id}`;
  if (snapshot) {
    return (
      <BeschreibungFassung
        abschnitte={snapshot.abschnitte}
        quelle={{
          modus: 'snapshot',
          stand: snapshot.stand ?? null,
          satz: snapshot.bausteine ?? null,
        }}
        snapshotSha256={f.version.snapshotSha256}
        lueckenHinweis={false}
        idPraefix={idPraefix}
      />
    );
  }
  const satz = live?.bausteine ?? null;
  return (
    <BeschreibungFassung
      abschnitte={f.version.abschnitte}
      quelle={{
        modus: 'live',
        stand: live?.stand ?? null,
        satz,
        namen: Object.fromEntries(
          bausteinPersonIds(satz).map((id) => [id.toLowerCase(), namen.name(id)]),
        ),
      }}
      lueckenHinweis={false}
      idPraefix={idPraefix}
    />
  );
}

/** Offene Freigabe oder Kenntnisnahme mit der Bedienung, die der Dienst erlaubt. */
export function FreigabeKarte({
  f,
  namen,
  gvNamen,
  zeigeDokument,
  live,
  aktionen,
}: {
  f: PortalFreigabeView;
  namen: Namen;
  /** Namen der gesetzlichen Vertretung (Hinweis für Nicht-Berechtigte). */
  gvNamen: string;
  /** Inhalt sichtbar (Übersichtsrecht oder adressierte Person, laut Dienst). */
  zeigeDokument: boolean;
  live: { stand: string; bausteine: BausteinSatzDaten } | null;
  aktionen: FreigabeAktionen;
}) {
  const code = f.brauchtCode;
  const empfaenger = namen.name(f.empfaengerId);
  const adressat = code ? `für die gesetzliche Vertretung (${empfaenger})` : `an ${empfaenger}`;
  return (
    <article className="rounded border border-default p-4 space-y-3" aria-labelledby={`f-${f.id}`}>
      <div className="flex items-start gap-3">
        <DokThumb />
        <div className="grow">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`f-${f.id}`} className="text-base font-semibold text-primary">
              {f.titel}
            </h3>
            <span className={code ? 'badge-yellow' : 'badge-brand'}>{freigabeArtLabel(f.art)}</span>
          </div>
          <p className="text-xs text-muted mt-1">
            {code ? 'angefordert' : 'zur Kenntnis gebeten'} am {isoDatumText(f.angefordertAm)} von{' '}
            {namen.name(f.angefordertVon)} · {adressat}
          </p>
        </div>
      </div>

      {zeigeDokument && (f.version || f.inhalt) ? (
        <details className="details-box">
          <summary>
            <FileText className="h-4 w-4" aria-hidden="true" /> Dokument ansehen
          </summary>
          <div className="details-body max-h-[32rem] overflow-y-auto">
            <FreigabeDokument f={f} live={live} namen={namen} />
          </div>
        </details>
      ) : null}

      <div className="border-t border-default pt-3">
        {code ? (
          <CodeBedienung f={f} gvNamen={gvNamen} aktionen={aktionen} />
        ) : f.darfKenntnisnehmen ? (
          <KenntnisnahmeFormular aktion={aktionen.kenntnisnehmen} />
        ) : (
          <Gesperrt text={f.sperrgrund ?? `Diese Kenntnisnahme ist an ${empfaenger} gerichtet.`} />
        )}
      </div>
    </article>
  );
}

/** Erledigte Freigabe, Kenntnisnahme oder frühere Version als Zeile. */
export function ErledigtZeile({
  titel,
  art,
  text,
  hash,
  abgelehnt = false,
}: {
  titel: string;
  art: string;
  text: string;
  hash?: string | null;
  abgelehnt?: boolean;
}) {
  const Icon = abgelehnt ? Ban : CheckCheck;
  return (
    <li className="flex flex-wrap items-start gap-3 px-6 py-3 border-b border-default last:border-b-0">
      <span className={`kpi-chip ${abgelehnt ? 'chip-gray' : 'chip-green'}`} aria-hidden="true">
        <Icon className="h-4 w-4" />
      </span>
      <span className="grow min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-primary">{titel}</span>
          <span className="badge-gray">{freigabeArtLabel(art)}</span>
        </span>
        <span className="block text-xs text-muted mt-1">{text}</span>
      </span>
      {hash ? (
        <span className="badge-gray gap-1 shrink-0" title="SHA-256 der freigegebenen Fassung">
          <Lock className="h-3 w-3" aria-hidden="true" />
          <HashKurz wert={hash} />
        </span>
      ) : null}
    </li>
  );
}

/** Text einer erledigten Anforderung aus Status, Art und Personen (Namen aus der kanzleikonsole). */
export function erledigtText(
  f: PortalFreigabeView,
  namen: Namen,
): { text: string; abgelehnt: boolean } {
  if (f.status === 'ABGELEHNT') {
    return {
      text: `${f.anmerkung ?? 'nicht mehr offen'} · ${isoZeitText(f.erledigtAm)}`,
      abgelehnt: true,
    };
  }
  if (f.art === 'KENNTNISNAHME') {
    return {
      text: `zur Kenntnis genommen · ${namen.name(f.empfaengerId)} · ${isoZeitText(f.erledigtAm)}`,
      abgelehnt: false,
    };
  }
  const wer = namen.name(f.version?.freigegebenVon ?? f.empfaengerId);
  return {
    text: `freigegeben · ${wer} · ${isoZeitText(f.erledigtAm)} · E-Mail-Code bestätigt`,
    abgelehnt: false,
  };
}
