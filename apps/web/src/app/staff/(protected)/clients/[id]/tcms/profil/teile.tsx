// =============================================================================
// Teile der Seite „Geschäftsprofil“ (TCMS Stufe 3, Bereich A): Profilstand,
// Teilbereich & Ziele, Historie und Risikovorschlag. Reine Darstellung des
// Modells aus page.tsx; „Risiko aufnehmen“ läuft über ./actions.ts.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { CheckCheck, History, Plus } from 'lucide-react';
import type { KontextAntwort, ProfilDaten } from '@taxtronik/tcms-contract';
import {
  addTage,
  fmtEurGanz,
  isoDatum,
  katalogRisiko,
  KLASSE_LABEL,
  profilDiff,
  type Geschaeftsprofil,
} from '@taxtronik/tcms-domain';
import { GtBadge } from '@/components/tcms/badges';
import { alsDatum, isoDatumText, isoZeitText } from '@/components/tcms/format';
import { TcmsLeer } from '@/components/tcms/leer';
import { TcmsKnopfAktion } from '@/components/tcms/programm/knopf';
import { ProfilAnzeige, ProfilDiffListe } from '@/components/tcms/programm/profil-anzeige';
import type { TcmsNamen } from '@/server/tcms/namen';
import { risikoAufnehmenAction } from './actions';

export type Stand = ProfilDaten['staende'][number];
type Vorschlag = ProfilDaten['vorschlaege'][number];

const tag = (iso: string) => iso.slice(0, 10);
const antworten = (s: Stand) => s.antworten as Geschaeftsprofil;

/** Stand gilt am Stichtag (Tage der Antwort; `gueltigBis` nach dem Stichtag liefert der Dienst als null). */
export function gueltigAm(s: Stand, stand: string): boolean {
  return tag(s.gueltigAb) <= stand && (s.gueltigBis === null || tag(s.gueltigBis) > stand);
}

export interface ProfilModell {
  mandantId: string;
  basis: string;
  ctx: KontextAntwort;
  p: ProfilDaten;
  namen: TcmsNamen;
  /** Zum Stichtag gültiger Stand. */
  angezeigt: Stand | null;
  /** Offener (jüngster) Stand – Basis einer Änderung. */
  juengster: Stand | null;
  /** Grund, warum „Risiko aufnehmen“ nicht angeboten wird (null: angeboten). */
  aufnehmenGesperrt: string | null;
}

export function vorgaenger(staende: readonly Stand[], s: Stand): Stand | null {
  return staende[staende.indexOf(s) - 1] ?? null;
}

const vorab = (s: Stand) => tag(s.createdAt) < tag(s.gueltigAb);

function zustand(m: ProfilModell, s: Stand): { text: string; ton: string } {
  const { ctx } = m;
  if (s === m.angezeigt) {
    return ctx.historisch
      ? { text: `Stand zum ${isoDatumText(ctx.stand)}`, ton: 'badge-yellow' }
      : { text: 'aktuell', ton: 'badge-green' };
  }
  if (tag(s.gueltigAb) > ctx.stand) {
    return ctx.historisch
      ? { text: 'nach dem Stichtag', ton: 'badge-gray' }
      : { text: 'geplant', ton: 'badge-brand' };
  }
  return { text: 'abgelöst', ton: 'badge-gray' };
}

function mitStand(m: ProfilModell, href: string): string {
  return m.ctx.historisch ? `${href}${href.includes('?') ? '&' : '?'}stand=${m.ctx.stand}` : href;
}

// ---------------------------------------------------------------------------
// Profilstand
// ---------------------------------------------------------------------------

function fussRechts(m: ProfilModell): string {
  if (m.ctx.historisch) return 'nur Lesen';
  if (m.juengster && m.juengster !== m.angezeigt)
    return `geplanter Stand ab ${isoDatumText(m.juengster.gueltigAb)}`;
  return 'Antworten steuern den Risikovorschlag';
}

export function StandKarte({ m }: { m: ProfilModell }) {
  const s = m.angezeigt;
  const vor = s ? vorgaenger(m.p.staende, s) : null;
  const diff = s && vor ? profilDiff(antworten(vor), antworten(s)) : [];
  return (
    <section className="card xl:col-span-2 overflow-hidden" aria-labelledby="profil-stand">
      <div className="card-header">
        <h3 id="profil-stand" className="text-sm font-semibold text-primary">
          Geschäftsprofil P1–P12
          {s ? (
            <span className="font-normal text-muted"> · gültig ab {isoDatumText(s.gueltigAb)}</span>
          ) : null}
        </h3>
        {s ? <span className={zustand(m, s).ton}>{zustand(m, s).text}</span> : null}
      </div>
      {s ? (
        <>
          <div className="px-6 py-3">
            <ProfilAnzeige profil={antworten(s)} geaendert={new Set(diff.map((d) => d.key))} />
          </div>
          <div className="card-footer flex flex-wrap justify-between gap-2">
            <span>
              Erfasst von {m.namen.name(s.erstelltVon)}
              {vorab(s) ? ` · angelegt am ${isoZeitText(s.createdAt)}` : ''}
              {diff.length ? ` · ${diff.length} Frage(n) gegenüber dem Vorgänger geändert` : ''}
            </span>
            <span>{fussRechts(m)}</span>
          </div>
        </>
      ) : (
        <TcmsLeer
          icon={History}
          text={`Zum ${isoDatumText(m.ctx.stand)} bestand noch kein Profilstand.`}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Teilbereich & Ziele
// ---------------------------------------------------------------------------

function ZielFreigabe({ m, z }: { m: ProfilModell; z: KontextAntwort['ziele'][number] }) {
  if (z.freigabe === 'FREIGEGEBEN') {
    return (
      <span className="badge-green">
        freigegeben · {m.namen.name(z.freigegebenVon)} · {isoDatumText(z.freigegebenAm)}
      </span>
    );
  }
  if (z.freigabe === 'AUSSTEHEND')
    return <span className="badge-yellow">Mandantenfreigabe ausstehend</span>;
  return <span className="badge-gray">Entwurf</span>;
}

export function TeilbereichZiele({ m }: { m: ProfilModell }) {
  const tb = m.ctx.teilbereich;
  return (
    <section className="card" aria-labelledby="profil-teilbereich">
      <div className="card-header">
        <h3 id="profil-teilbereich" className="text-sm font-semibold text-primary">
          Teilbereich & Ziele
        </h3>
      </div>
      <div className="px-4 py-3">
        {tb ? (
          <>
            <p className="text-sm font-medium">{tb.name}</p>
            <p className="text-xs text-muted mt-1">{tb.abgrenzung}</p>
            <ul className="flex flex-wrap gap-1 mt-2" aria-label="Ein- und Ausschlüsse">
              {tb.einschluesse.map((x) => (
                <li key={`e-${x}`} className="badge-green">
                  {x}
                </li>
              ))}
              {tb.ausschluesse.map((x) => (
                <li key={`a-${x}`} className="badge-gray">
                  <span className="sr-only">Ausschluss: </span>
                  {x}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted">Kein Teilbereich abgegrenzt.</p>
        )}
      </div>
      <ul>
        {m.ctx.ziele.map((z) => (
          <li key={z.id} className="border-t border-default px-4 py-2">
            <p className="text-xs">{z.text}</p>
            <p className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-muted">
              Wesentlichkeit {fmtEurGanz(z.wesentlichkeitEur)} · Appetit{' '}
              {KLASSE_LABEL[z.risikoappetit]}
              <ZielFreigabe m={m} z={z} />
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Historie
// ---------------------------------------------------------------------------

/** Ansicht eines abgelösten Stands nur, wenn er mindestens einen ganzen Kalendertag galt. */
function ansichtTag(m: ProfilModell, s: Stand): string | null {
  if (!s.gueltigBis || s === m.angezeigt || tag(s.gueltigBis) > m.ctx.stand) return null;
  const bis = alsDatum(s.gueltigBis);
  const letzter = bis ? isoDatum(addTage(bis, -1)) : null;
  return letzter && letzter >= tag(s.gueltigAb) ? letzter : null;
}

function HistorienEintrag({ m, s }: { m: ProfilModell; s: Stand }) {
  const z = zustand(m, s);
  const vor = vorgaenger(m.p.staende, s);
  const diff = vor ? profilDiff(antworten(vor), antworten(s)) : null;
  const ansicht = ansichtTag(m, s);
  const aktiv = s === m.angezeigt;
  return (
    <li
      className={`border-t border-default px-4 py-3 ${aktiv ? 'bg-surface-raised' : ''}`}
      aria-current={aktiv ? 'true' : undefined}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Stand {m.p.staende.indexOf(s) + 1}</span>
        <span className={z.ton}>{z.text}</span>
      </div>
      <p className="text-xs text-muted mt-1">
        gültig ab {isoDatumText(s.gueltigAb)}
        {s.gueltigBis ? ` bis ${isoDatumText(s.gueltigBis)}` : ''} · {m.namen.name(s.erstelltVon)}
        {vorab(s) ? ` · angelegt am ${isoZeitText(s.createdAt)}` : ''}
      </p>
      {diff ? (
        <details className="details-box mt-2" open={aktiv || s === m.juengster}>
          <summary className="text-xs">
            Änderungen zum Vorgänger ({diff.length} {diff.length === 1 ? 'Frage' : 'Fragen'})
          </summary>
          <div className="details-body">
            <ProfilDiffListe diff={diff} />
          </div>
        </details>
      ) : (
        <p className="text-xs text-muted mt-1">Erstanlage im Einrichtungsassistenten.</p>
      )}
      {ansicht ? (
        <Link
          className="text-xs underline mt-1 inline-block"
          href={`${m.basis}/profil?stand=${ansicht}`}
        >
          Stand zum {isoDatumText(ansicht)} ansehen
        </Link>
      ) : null}
    </li>
  );
}

export function Historie({ m }: { m: ProfilModell }) {
  return (
    <section className="card" id="historie" aria-labelledby="profil-historie">
      <div className="card-header">
        <h3 id="profil-historie" className="text-sm font-semibold text-primary">
          Historie
        </h3>
        <span className="badge-gray">{m.p.staende.length} Stände</span>
      </div>
      <ol>
        {[...m.p.staende].reverse().map((s) => (
          <HistorienEintrag key={s.id} m={m} s={s} />
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Risikovorschlag
// ---------------------------------------------------------------------------

function Abschnitt({
  id,
  titel,
  anzahl,
  ton = 'badge-gray',
  hinweis,
  children,
}: {
  id: string;
  titel: string;
  anzahl: number;
  ton?: string;
  hinweis?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="border-t border-default">
      <div className="flex items-center justify-between px-6 pt-3 pb-1">
        <h4 id={id} className="text-sm font-semibold text-primary">
          {titel}
        </h4>
        <span className={ton}>{anzahl}</span>
      </div>
      {hinweis ? <p className="hint px-6 pb-1">{hinweis}</p> : null}
      <ul>{children}</ul>
    </section>
  );
}

function VorschlagKopf({ v }: { v: Vorschlag }) {
  const kat = katalogRisiko(v.code);
  return (
    <div className="min-w-0 grow">
      <p className="text-sm font-medium">
        {v.code} · {kat?.titel ?? v.code}
      </p>
      <div className="flex flex-wrap gap-1.5 mt-1">
        <span className="badge-brand" title={`Profilantwort ${v.frage}`}>
          {v.grund}
        </span>
        {kat ? <GtBadge gt={kat.gt} /> : null}
        {v.kern ? <span className="badge-gray">Kernrisiko</span> : null}
      </div>
    </div>
  );
}

function Aufnehmen({ m, code, label }: { m: ProfilModell; code: string; label: string }) {
  const gesperrt = m.aufnehmenGesperrt;
  return (
    <TcmsKnopfAktion
      aktion={risikoAufnehmenAction.bind(null, m.mandantId)}
      versteckt={{ code }}
      knopfKlasse="btn-secondary text-xs py-1 shrink-0"
      erfolg={`${code} wurde aufgenommen.`}
      deaktiviert={gesperrt !== null}
      {...(gesperrt ? { deaktiviertGrund: gesperrt } : {})}
      titel={`${code} mit Katalogkontrollen ins Risikoinventar aufnehmen`}
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {label}
      <span className="sr-only"> ({code})</span>
    </TcmsKnopfAktion>
  );
}

function NeuUndAbgelehnt({ m }: { m: ProfilModell }) {
  const neu = m.p.vorschlaege.filter((v) => v.entscheidung === 'OFFEN');
  const abgelehnt = m.p.vorschlaege.filter((v) => v.entscheidung === 'ABGELEHNT');
  const grund = new Map(m.p.risiken.map((r) => [r.id, r.ablehnungsgrund]));
  return (
    <>
      {neu.length ? (
        <Abschnitt
          id="profil-neu"
          titel="Neu vorgeschlagen"
          anzahl={neu.length}
          ton="badge-brand"
          hinweis="Aufnehmen legt das Risiko mit Brutto-Startwerten und die noch fehlenden Katalogkontrollen an; Verantwortliche sind Berufsträger:in und Hauptbearbeitung des Mandanten."
        >
          {neu.map((v) => (
            <li key={v.code} className="flex flex-wrap items-start gap-3 px-6 py-2">
              <VorschlagKopf v={v} />
              <Aufnehmen m={m} code={v.code} label="Risiko aufnehmen" />
            </li>
          ))}
        </Abschnitt>
      ) : null}
      {abgelehnt.length ? (
        <Abschnitt
          id="profil-abgelehnt"
          titel="Begründet abgelehnt, weiterhin vorgeschlagen"
          anzahl={abgelehnt.length}
        >
          {abgelehnt.map((v) => (
            <li key={v.code} className="flex flex-wrap items-start gap-3 px-6 py-2">
              <div className="min-w-0 grow">
                <VorschlagKopf v={v} />
                <p className="text-xs text-muted mt-1">
                  Ablehnung: {(v.risikoId ? grund.get(v.risikoId) : null) ?? '—'}
                </p>
              </div>
              <Aufnehmen m={m} code={v.code} label="Doch aufnehmen" />
            </li>
          ))}
        </Abschnitt>
      ) : null}
    </>
  );
}

function ImInventar({ m }: { m: ProfilModell }) {
  const deaktiviert = m.p.vorschlaege.filter((v) => v.entscheidung === 'DEAKTIVIERT');
  const vorgeschlagen = new Set(m.p.vorschlaege.map((v) => v.code));
  const nichtMehr = m.ctx.risiken.filter((r) => !r.kern && !vorgeschlagen.has(r.code));
  const neuBewerten = m.ctx.historisch ? [] : m.ctx.risiken.filter((r) => r.neuBewerten);
  const risiken = mitStand(m, `${m.basis}/risiken`);
  return (
    <>
      {deaktiviert.length ? (
        <Abschnitt
          id="profil-deaktiviert"
          titel="Deaktiviert, erneut vorgeschlagen"
          anzahl={deaktiviert.length}
          hinweis="Die Reaktivierung erfolgt im Risikoinventar."
        >
          {deaktiviert.map((v) => (
            <li key={v.code} className="flex flex-wrap items-start gap-3 px-6 py-2">
              <VorschlagKopf v={v} />
              <Link className="btn-secondary text-xs py-1" href={risiken}>
                Zum Risikoinventar<span className="sr-only"> ({v.code})</span>
              </Link>
            </li>
          ))}
        </Abschnitt>
      ) : null}
      {nichtMehr.length ? (
        <Abschnitt
          id="profil-nicht-mehr"
          titel="Nicht mehr vorgeschlagen"
          anzahl={nichtMehr.length}
          hinweis="Das Risiko bleibt aktiv, bis es im Risikoinventar bewusst deaktiviert wird."
        >
          {nichtMehr.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start gap-3 px-6 py-2">
              <div className="min-w-0 grow">
                <p className="text-sm font-medium">
                  {r.code} · {r.titel}
                </p>
                <p className="text-xs text-muted mt-1">
                  Ursprünglicher Grund: {r.vorschlagsgrund ?? '—'}
                </p>
              </div>
              <span className="badge-gray shrink-0">bleibt aktiv</span>
              <Link className="btn-secondary text-xs py-1 shrink-0" href={risiken}>
                Prüfen<span className="sr-only"> ({r.code})</span>
              </Link>
            </li>
          ))}
        </Abschnitt>
      ) : null}
      {neuBewerten.length ? (
        <Abschnitt
          id="profil-neubewerten"
          titel="Zur Neubewertung markiert"
          anzahl={neuBewerten.length}
          ton="badge-yellow"
          hinweis="Markiert durch Profiländerung oder Ereignis-Triage; die Bewertung erfolgt im Risikoinventar."
        >
          {neuBewerten.map((r) => (
            <li key={r.id} className="inline-block pl-6 pb-3">
              <Link href={risiken} className="badge-yellow" title={r.titel}>
                {r.code}
              </Link>
            </li>
          ))}
        </Abschnitt>
      ) : null}
    </>
  );
}

/** Erfolgsmeldung nach „Risiko aufnehmen“ (Werte aus der Weiterleitung, auf der Seite geprüft). */
export interface AufnahmeMeldung {
  code: string;
  kn: string[];
  vk: string[];
  ng: string[];
  d: number;
}

function Aufgenommen({ a }: { a: AufnahmeMeldung }) {
  return (
    <p className="alert-success mb-3 text-sm" role="status">
      {a.code} ins Risikoinventar aufgenommen (Brutto-Startwerte, Status bewertet)
      {a.kn.length ? ` · Kontrollen angelegt: ${a.kn.join(', ')}` : ''}
      {a.vk.length ? ` · verknüpft mit ${a.vk.join(', ')}` : ''}
      {a.ng.length ? ` · künftige Durchführungen neu geplant: ${a.ng.join(', ')}` : ''}
      {a.d ? ` · ${a.d} Durchführungen geplant` : ''}. Designbeurteilung und Freigabe folgen im
      Risikoinventar und in der Kontrollmatrix.
    </p>
  );
}

export function Vorschlaege({
  m,
  aufgenommen,
}: {
  m: ProfilModell;
  aufgenommen: AufnahmeMeldung | null;
}) {
  const v = m.p.vorschlaege;
  const zaehle = (e: Vorschlag['entscheidung']) => v.filter((x) => x.entscheidung === e).length;
  const vorgeschlagen = new Set(v.map((x) => x.code));
  const nichtMehr = m.ctx.risiken.filter((r) => !r.kern && !vorgeschlagen.has(r.code)).length;
  const offen = zaehle('OFFEN') + zaehle('ABGELEHNT') + zaehle('DEAKTIVIERT') + nichtMehr;
  return (
    <section
      className="card mt-4 overflow-hidden"
      id="vorschlaege"
      aria-labelledby="profil-vorschlaege"
    >
      <div className="card-header flex flex-wrap gap-2">
        <h3 id="profil-vorschlaege" className="text-sm font-semibold text-primary">
          Risikovorschlag aus dem Profil
        </h3>
        <span className="text-xs text-muted">
          {m.angezeigt ? `Profilstand gültig ab ${isoDatumText(m.angezeigt.gueltigAb)}` : '—'} ·
          deterministisch, je Vorschlag mit Grund
        </span>
      </div>
      <div className="p-4">
        {aufgenommen && !m.ctx.historisch ? <Aufgenommen a={aufgenommen} /> : null}
        <ul className="mini-kpis">
          <li className="mini-kpi">
            <div className="v">{v.length}</div>
            <div className="l">Vorschläge aus dem Profil</div>
          </li>
          <li className="mini-kpi">
            <div className="v">{zaehle('UEBERNOMMEN')}</div>
            <div className="l">davon im Risikoinventar</div>
          </li>
          <li className="mini-kpi">
            <div className="v">{zaehle('OFFEN') + zaehle('ABGELEHNT')}</div>
            <div className="l">nicht im Inventar ({zaehle('ABGELEHNT')} begründet abgelehnt)</div>
          </li>
          <li className="mini-kpi">
            <div className="v">{nichtMehr}</div>
            <div className="l">aktiv, aber nicht mehr vorgeschlagen</div>
          </li>
        </ul>
      </div>
      <NeuUndAbgelehnt m={m} />
      <ImInventar m={m} />
      {offen === 0 ? (
        <div className="border-t border-default">
          <TcmsLeer
            icon={CheckCheck}
            text={`Profil und Risikoinventar sind deckungsgleich: alle ${v.length} Vorschläge sind im Inventar.`}
          />
        </div>
      ) : null}
    </section>
  );
}
