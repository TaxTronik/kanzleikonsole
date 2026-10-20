// =============================================================================
// Folgen eines Ereignisses (TCMS Stufe 3, Bereich D; aus der Demo
// components/ereignisse/folge-zeile.tsx): Vorschläge zur Auswahl im Formular
// „Folgen anlegen“ und angelegte, erledigte oder verworfene Folgen mit dem
// verknüpften Objekt. Aktionen kommen gebunden von der Seite (Mandant, Ereignis,
// Folge); Status, Fristen und Verknüpfungen aus der Antwort des Dienstes,
// Namen aus der kanzleikonsole.
// =============================================================================

import Link from 'next/link';
import { Check } from 'lucide-react';
import type { FolgeDetailSchema } from '@taxtronik/tcms-contract';
import {
  AUSWIRKUNG_LABEL,
  FESTSTELLUNG_KLASSE_LABEL,
  FOLGE_LABEL,
  KLASSE_LABEL,
  MIN_BEGRUENDUNG,
  type Auswirkung,
  type FeststellungKlasse,
  type Klasse,
} from '@taxtronik/tcms-domain';
import type { z } from 'zod';
import { AnzeigeBadge } from '../badges';
import { isoDatumText, isoZeitText } from '../format';
import { TcmsAktionsKnopf, TcmsFormDialog, type TcmsFormAktion } from './aktionen';
import { FOLGE_STATUS_BADGE, FOLGE_STATUS_LABEL } from './texte';
import { TCMS_TEXT_ISOLIERT, TcmsText } from '@/components/tcms/text';

export type FolgeDetail = z.infer<typeof FolgeDetailSchema>;

export interface PersonOption {
  wert: string;
  label: string;
}

const KLASSEN = Object.keys(FESTSTELLUNG_KLASSE_LABEL) as FeststellungKlasse[];
const SCHWEREN: Klasse[] = ['GERING', 'MITTEL', 'HOCH', 'KRITISCH'];
const AUSWIRKUNGEN: Auswirkung[] = ['JA', 'NEIN', 'UNKLAR'];

function titelDerFolge(f: Pick<FolgeDetail, 'art' | 'ziel'>): string {
  return `${FOLGE_LABEL[f.art]}${f.ziel ? ` ${f.ziel}` : ''}`;
}

/**
 * Zeile eines Folgevorschlags im Formular „Folgen anlegen“ (Felder je Folge:
 * `folge`, `zustaendig_<id>`, `frist_<id>`, bei Feststellungen `ftitel_<id>`,
 * `fklasse_<id>`, `fschwere_<id>`, `fauswirkung_<id>`). Klasse, Schwere und
 * Auswirkung ohne Vorauswahl.
 */
export function VorschlagZeile({
  f,
  personen,
  standardZustaendig,
  standardFrist,
  heute,
  vorbelegt,
  hinweis,
  ereignisTitel,
  gesperrt,
  verwerfen,
}: {
  f: FolgeDetail;
  personen: readonly PersonOption[];
  standardZustaendig: string | null;
  standardFrist: string;
  heute: string;
  vorbelegt: boolean;
  hinweis: string | null;
  ereignisTitel: string;
  gesperrt: string | null;
  verwerfen: TcmsFormAktion;
}) {
  const titel = titelDerFolge(f);
  const feststellung = f.art === 'FESTSTELLUNG_ANLEGEN';
  const kontrolle = f.art === 'KONTROLLE_AUSSERPLANMAESSIG';
  const aus = gesperrt !== null;
  return (
    <li className="flex flex-wrap items-start gap-3 py-3 border-b border-default last:border-b-0">
      <input
        type="checkbox"
        name="folge"
        value={f.id}
        id={`folge-${f.id}`}
        defaultChecked={vorbelegt}
        disabled={aus}
        className="mt-1"
      />
      <div className="grow min-w-0 space-y-2">
        <label htmlFor={`folge-${f.id}`} className="block">
          <span className="block text-sm font-medium text-primary">{titel}</span>
          <span className="block text-xs text-muted">
            <TcmsText>{f.text}</TcmsText>
          </span>
        </label>
        {hinweis ? <p className="text-xs text-red-700 dark:text-red-400">{hinweis}</p> : null}
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={`zustaendig-${f.id}`} className="label-sm">
              Zuständigkeit
            </label>
            <select
              id={`zustaendig-${f.id}`}
              name={`zustaendig_${f.id}`}
              className="input py-1 text-xs w-auto"
              defaultValue={standardZustaendig ?? ''}
              disabled={aus}
            >
              <option value="">nicht festgelegt</option>
              {personen.map((p) => (
                <option {...TCMS_TEXT_ISOLIERT} key={p.wert} value={p.wert}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`frist-${f.id}`} className="label-sm">
              {kontrolle ? 'Fällig am (Pflicht)' : 'Frist'}
            </label>
            <input
              id={`frist-${f.id}`}
              type="date"
              name={`frist_${f.id}`}
              className="input py-1 text-xs w-auto"
              defaultValue={feststellung ? '' : standardFrist}
              min={heute}
              disabled={aus}
            />
          </div>
        </div>
        {feststellung ? (
          <fieldset className="space-y-2">
            <legend className="label-sm">Feststellung</legend>
            <input
              name={`ftitel_${f.id}`}
              className="input py-1 text-xs"
              defaultValue={ereignisTitel}
              aria-label="Titel der Feststellung"
              maxLength={200}
              disabled={aus}
            />
            <div className="flex flex-wrap gap-2">
              <select
                name={`fklasse_${f.id}`}
                className="input py-1 text-xs w-auto"
                defaultValue=""
                aria-label="Klasse"
                disabled={aus}
              >
                <option value="">Klasse …</option>
                {KLASSEN.map((k) => (
                  <option key={k} value={k}>
                    {FESTSTELLUNG_KLASSE_LABEL[k]}
                  </option>
                ))}
              </select>
              <select
                name={`fschwere_${f.id}`}
                className="input py-1 text-xs w-auto"
                defaultValue=""
                aria-label="Schwere"
                disabled={aus}
              >
                <option value="">Schwere …</option>
                {SCHWEREN.map((k) => (
                  <option key={k} value={k}>
                    {KLASSE_LABEL[k]}
                  </option>
                ))}
              </select>
              <select
                name={`fauswirkung_${f.id}`}
                className="input py-1 text-xs w-auto"
                defaultValue=""
                aria-label="Steuerliche Auswirkung"
                disabled={aus}
              >
                <option value="">Steuerliche Auswirkung …</option>
                {AUSWIRKUNGEN.map((k) => (
                  <option key={k} value={k}>
                    steuerliche Auswirkung: {AUSWIRKUNG_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <p className="hint">
              „Keine Auswirkung“ ist eine Würdigungsentscheidung; ohne Würdigungsrecht legt das
              Tax-CMS die Feststellung als „unklar“ an.
            </p>
          </fieldset>
        ) : null}
      </div>
      <TcmsFormDialog
        aktion={verwerfen}
        ausloeser="verwerfen"
        ausloeserKlasse="btn-secondary text-xs py-1"
        titel={`Folge verwerfen: ${titel}`}
        hinweis="Ein Ereignis ist erst erledigt, wenn jede Folge erledigt oder begründet verworfen ist."
        bestaetigen="Verwerfen"
        gefahr
        begruendung={{ min: MIN_BEGRUENDUNG, max: 2000 }}
        gesperrt={gesperrt}
        erfolg="Folge begründet verworfen."
      />
    </li>
  );
}

/** Verknüpfte Objekte einer Folge (Durchführung, Feststellung, Risiko, Profil). */
function FolgeVerknuepfungen({ f, link }: { f: FolgeDetail; link: (pfad: string) => string }) {
  const d = f.durchfuehrung;
  return (
    <div className="flex flex-wrap items-center gap-2 mt-1">
      {d ? (
        <Link
          href={link(`/durchfuehrungen/${encodeURIComponent(d.id)}`)}
          className="inline-flex flex-wrap items-center gap-2 hover:underline"
        >
          <span className="badge-gray font-mono">{d.code}</span>
          <span className="text-xs text-muted">fällig {isoDatumText(d.faelligAm)}</span>
          <AnzeigeBadge status={d.anzeige} />
        </Link>
      ) : null}
      {f.feststellung ? (
        <Link
          href={link(`/feststellungen/${encodeURIComponent(f.feststellung.id)}`)}
          className="badge-gray hover:underline"
        >
          → {f.feststellung.nummer}
        </Link>
      ) : null}
      {f.ziel && (f.art === 'RISIKO_NEU_BEWERTEN' || f.art === 'RISIKO_AKTIVIEREN') ? (
        <Link
          href={link(`/risiken?risiko=${encodeURIComponent(f.ziel)}`)}
          className="badge-gray font-mono hover:underline"
        >
          <TcmsText>{f.ziel}</TcmsText>
        </Link>
      ) : null}
      {f.art === 'PROFIL_AENDERN' && f.status === 'ANGELEGT' ? (
        <Link href={link('/profil')} className="text-xs hover:underline">
          Geschäftsprofil öffnen →
        </Link>
      ) : null}
      {f.status === 'ERLEDIGT' && f.erledigtAm ? (
        <span className="text-xs text-muted">erledigt {isoZeitText(f.erledigtAm)}</span>
      ) : null}
    </div>
  );
}

/** Zuständigkeit, Frist und Anlage einer Folge in einer Zeile. */
function folgeAngaben(
  f: FolgeDetail,
  namen: { name(id: string | null | undefined): string },
): string {
  const zustaendig = f.zustaendig ? `Zuständig: ${namen.name(f.zustaendig)}` : 'ohne Zuständigkeit';
  const frist = f.frist ? ` · Frist ${isoDatumText(f.frist)}` : '';
  const angelegt = f.angelegt
    ? ` · angelegt von ${namen.name(f.angelegt.vonId)}, ${isoZeitText(f.angelegt.am)}`
    : '';
  return `${zustaendig}${frist}${angelegt}`;
}

/** Angelegte, erledigte oder verworfene Folge mit verknüpftem Objekt. */
export function FolgeZeile({
  f,
  link,
  namen,
  gesperrt,
  erledigen,
  verwerfen,
}: {
  f: FolgeDetail;
  /** Link in einen Bereich des Mandanten (Stichtag bleibt erhalten). */
  link: (pfad: string) => string;
  namen: { name(id: string | null | undefined): string };
  gesperrt: string | null;
  erledigen: TcmsFormAktion;
  verwerfen: TcmsFormAktion;
}) {
  const titel = titelDerFolge(f);
  const d = f.durchfuehrung;
  // Anzeigeauswahl auf der Antwort des Dienstes; entscheidend bleibt der Dienst.
  const offeneDurchfuehrung =
    f.art === 'KONTROLLE_AUSSERPLANMAESSIG' &&
    !!d &&
    d.anzeige !== 'OHNE_BEFUND' &&
    d.anzeige !== 'MIT_BEFUND' &&
    d.anzeige !== 'ENTFALLEN';
  const erledigenGesperrt =
    gesperrt ??
    (offeneDurchfuehrung ? 'Erst nach abgeschlossener (gegengezeichneter) Durchführung.' : null);
  const punkt =
    f.status === 'ERLEDIGT' ? 'dot-green' : f.status === 'VERWORFEN' ? 'dot-gray' : 'dot-amber';
  return (
    <li className="flex flex-wrap items-start gap-3 py-3 border-b border-default last:border-b-0">
      <span className={`status-dot ${punkt} mt-2`} aria-hidden="true" />
      <div className="grow min-w-0">
        <p className="text-sm font-medium text-primary">{titel}</p>
        <p className="text-xs text-muted">
          <TcmsText>{f.text}</TcmsText>
        </p>
        <p className="text-xs text-muted mt-1">{folgeAngaben(f, namen)}</p>
        <FolgeVerknuepfungen f={f} link={link} />
        {f.verwerfen ? (
          <p className="text-xs text-muted mt-1">
            Verworfen · {namen.name(f.verwerfen.vonId)} · {isoZeitText(f.verwerfen.am)}:{' '}
            <TcmsText>{f.verwerfen.begruendung}</TcmsText>
          </p>
        ) : null}
      </div>
      <div className="flex flex-col items-end gap-2 shrink-0">
        <span className={FOLGE_STATUS_BADGE[f.status]}>{FOLGE_STATUS_LABEL[f.status]}</span>
        {f.status === 'ANGELEGT' ? (
          <div className="flex flex-wrap items-start justify-end gap-2">
            <TcmsAktionsKnopf
              aktion={erledigen}
              className="btn-secondary text-xs py-1"
              gesperrt={erledigenGesperrt}
              erfolg="Folge erledigt."
            >
              <Check className="h-3 w-3" aria-hidden="true" /> erledigt
            </TcmsAktionsKnopf>
            <TcmsFormDialog
              aktion={verwerfen}
              ausloeser="verwerfen"
              ausloeserKlasse="btn-secondary text-xs py-1"
              titel={`Folge verwerfen: ${titel}`}
              {...(f.art === 'KONTROLLE_AUSSERPLANMAESSIG'
                ? {
                    hinweis:
                      'Die angelegte Durchführung bleibt bestehen; sie entfällt nur mit Begründung und Freigabe in der Durchführung.',
                  }
                : {})}
              bestaetigen="Verwerfen"
              gefahr
              begruendung={{ min: MIN_BEGRUENDUNG, max: 2000 }}
              gesperrt={gesperrt}
              erfolg="Folge begründet verworfen."
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}
