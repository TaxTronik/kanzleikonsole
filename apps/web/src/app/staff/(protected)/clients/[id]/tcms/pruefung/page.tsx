// =============================================================================
// /staff/clients/:id/tcms/pruefung — Prüfungsvorbereitung (TCMS Stufe 3,
// portiert aus der Demo staff/clients/[id]/tcms/pruefung/page.tsx).
//
// Daten nur aus dem Kontext (`GET …/kontext`). Kennzahlen des
// Wirksamkeitszeitraums (`zeitraum`), Grundelemente und Phase berechnet der
// Dienst; die Lückenanalyse zählt nur Einträge nach dem Status, den der Dienst
// liefert (Auswahl, keine eigene Regel).
//
// „Kontrollen ohne Durchführung im Zeitraum“, „Nachweise dokumentiert“ und
// „entfallen“ zählt seit TCMS s7 der Dienst (`zeitraum.ohneDurchfuehrung`,
// `nachweise`, `entfallen`; Zeitfenster bis 60 Tage nach Zeitraumende wie in
// der Demo); die Seite zeigt nur diese Zahlen. Ein Prüfurteil trifft das
// Werkzeug nicht (TCMS-EFFECTIVENESS-001).
// =============================================================================

import Link from 'next/link';
import { ChevronRight, Download, FileSearch, FileText, Lock } from 'lucide-react';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { MONATE, PHASEN } from '@taxtronik/tcms-domain';
import { HashKurz } from '@/components/tcms/badges';
import {
  auswertenKontext,
  kopfDaten,
  standQuery,
  type KontextMitProgramm,
} from '@/components/tcms/bereich-b/laden';
import { mitStand, standFuerLinks, type SuchParameter } from '@/components/tcms/bereich-b/seite';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import { alsDatum, isoDatumText, isoZeitText } from '@/components/tcms/format';
import { KatalogIcon } from '@/components/tcms/icon';
import { TcmsKopf } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import { ZeitraumLeiste } from '@/components/tcms/visual';
import { TcmsZustand } from '@/components/tcms/zustand';
import type { TcmsNamen } from '@/server/tcms/namen';
import { personIdsAus } from '@/server/tcms/namen';
import { tcmsLesenOptional, tcmsMandantSeite, tcmsNamenLesen } from '@/server/tcms/seite';

export const metadata = { title: 'Tax-CMS – Prüfungsvorbereitung' };

/** Grundelement → Unterseite (wie im Cockpit). */
const GRUNDELEMENT_ZIEL: Readonly<Record<string, string>> = {
  risiken: 'risiken',
  programm: 'kontrollen',
  ueberwachung: 'feststellungen',
  ziele: 'profil',
};

interface Luecke {
  text: string;
  anzahl: number;
  ziel: string;
  /** Nur im begonnenen Wirksamkeitszeitraum aussagekräftig. */
  nurZeitraum?: boolean;
  rot?: boolean;
  /** Betroffene Einträge (Codes des Dienstes), z. B. Kontrollen ohne Durchführung. */
  codes?: readonly string[];
}

type Ansicht = { ctx: KontextMitProgramm; link: (pfad: string) => string };

/** Hat der Wirksamkeitszeitraum zum Stichtag begonnen (Daten des Programms)? */
function zeitraumBegonnen(ctx: KontextMitProgramm): boolean {
  return !!ctx.programm.wirksamAb && ctx.programm.wirksamAb.slice(0, 10) <= ctx.stand;
}

/** Monatslabels des Wirksamkeitszeitraums („Jul 26“ …) aus den Daten des Programms. */
function zeitraumMonate(ab: string, bis: string): string[] {
  const a = alsDatum(ab);
  const b = alsDatum(bis);
  if (!a || !b) return [];
  const n = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1;
  return Array.from({ length: Math.max(0, Math.min(n, 36)) }, (_, i) => {
    const d = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + i, 1));
    return `${(MONATE[d.getUTCMonth()] ?? '').slice(0, 3)} ${String(d.getUTCFullYear()).slice(2)}`;
  });
}

/** Lücken als Auswahl nach Status bzw. Zahlen des Dienstes. */
function lueckenAus(ctx: KontextMitProgramm): Luecke[] {
  const zr = ctx.zeitraum;
  const offenHoch = ctx.feststellungen.filter(
    (f) =>
      // Schwere nur aus lesbaren Feststellungen (RT-01: maskierte ohne Inhalt).
      !f.maskiert &&
      (f.schwere === 'HOCH' || f.schwere === 'KRITISCH') &&
      f.status !== 'GESCHLOSSEN' &&
      f.status !== 'VERWORFEN',
  ).length;
  return [
    {
      // Wiederkehrende Kontrollen ohne (auch geplante) Durchführung im Zeitraum (TCMS s7).
      text: 'Kontrollen ohne Durchführung im Zeitraum',
      anzahl: zr?.ohneDurchfuehrung.length ?? 0,
      ziel: 'kontrollen',
      nurZeitraum: true,
      rot: true,
      codes: zr?.ohneDurchfuehrung ?? [],
    },
    {
      text: 'Durchführungen ohne ausreichende Nachweise',
      anzahl: zr?.fehlendeNachweise ?? 0,
      ziel: 'kontrollen',
      nurZeitraum: true,
      rot: true,
    },
    {
      text: 'Durchführungen ohne Gegenzeichnung',
      anzahl: zr?.ohneGegenzeichnung ?? 0,
      ziel: 'kontrollen',
      nurZeitraum: true,
    },
    {
      text: 'Überfällige Durchführungen',
      anzahl: ctx.durchfuehrungen.filter((d) => d.anzeige === 'UEBERFAELLIG').length,
      ziel: 'kontrollen',
      rot: true,
    },
    {
      text: 'Offene Feststellungen hoch/kritisch',
      anzahl: offenHoch,
      ziel: 'feststellungen',
      rot: true,
    },
    {
      text: 'Offene §-153-Würdigungen',
      anzahl: ctx.feststellungen.filter((f) => !f.maskiert && f.p153Offen).length,
      ziel: 'feststellungen',
      rot: true,
    },
    {
      text: 'CMS-Beschreibung nicht freigegeben',
      anzahl: ctx.beschreibungen.some((b) => b.status === 'FREIGEGEBEN') ? 0 : 1,
      ziel: 'beschreibung',
    },
    {
      text: 'Risiken ohne Freigabe',
      anzahl: ctx.risiken.filter((r) => r.freigabe !== 'FREIGEGEBEN').length,
      ziel: 'risiken',
    },
    {
      text: 'Kontrollen ohne Designbeurteilung',
      anzahl: ctx.kontrollen.filter((k) => k.design === 'NICHT_BEURTEILT').length,
      ziel: 'kontrollen',
    },
  ];
}

function Gegenstand({ ctx }: Ansicht) {
  const p = ctx.programm;
  const zr = ctx.zeitraum;
  const begonnen = zeitraumBegonnen(ctx);
  const geplant = !!p.angemessenheitStichtag && p.angemessenheitStichtag.slice(0, 10) > ctx.stand;
  const freigabe = ctx.beschreibungen.find((b) => b.status === 'FREIGEGEBEN') ?? null;
  const leiste =
    p.wirksamAb && p.wirksamBis
      ? zeitraumMonate(p.wirksamAb, p.wirksamBis).map((label, i) => {
          const monat = zr?.monat ?? 0;
          const zustand: 'done' | 'now' | '' = !begonnen
            ? ''
            : i + 1 < monat
              ? 'done'
              : i + 1 === monat
                ? 'now'
                : '';
          return { label, zustand, offen: 0 };
        })
      : [];
  const zeitraumText =
    zr && begonnen
      ? `Monat ${Math.min(zr.monat, zr.monate)} von ${zr.monate}`
      : p.wirksamAb
        ? `beginnt ${isoDatumText(p.wirksamAb)}`
        : 'nicht festgelegt';
  return (
    <section className="card xl:col-span-2" aria-labelledby="tcms-pruefungsgegenstand">
      <div className="card-header">
        <h3 id="tcms-pruefungsgegenstand" className="text-sm font-semibold text-primary">
          Prüfungsgegenstand
        </h3>
        <span className="text-xs text-muted">{ctx.teilbereich?.name ?? '—'}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-4">
        <div className="rounded-lg border border-default p-4">
          <p className="text-sm font-semibold text-primary">1 · Angemessenheit zum Stichtag</p>
          <p className="text-xs text-muted">Design und Implementierung zu einem Zeitpunkt</p>
          <p className="mt-3 text-xs text-muted">Stichtag</p>
          <p className="text-lg font-bold font-mono">
            {p.angemessenheitStichtag ? isoDatumText(p.angemessenheitStichtag) : '—'}
            {geplant ? <span className="text-xs font-normal"> (geplant)</span> : null}
          </p>
          <p className="text-xs text-muted mt-1">
            {freigabe
              ? `Beschreibung v${freigabe.nummer} freigegeben ${isoDatumText(freigabe.freigegebenAm)}`
              : 'noch keine freigegebene Beschreibung'}
          </p>
        </div>
        <div className="rounded-lg border border-default p-4">
          <p className="text-sm font-semibold text-primary">2 · Wirksamkeit über Zeitraum</p>
          <p className="text-xs text-muted">gelebte Kontrollen über den Wirksamkeitszeitraum</p>
          <p className="mt-3 text-xs text-muted">Zeitraum</p>
          <p className="text-lg font-bold font-mono">
            {p.wirksamAb && p.wirksamBis
              ? `${isoDatumText(p.wirksamAb)} – ${isoDatumText(p.wirksamBis)}`
              : '—'}
          </p>
          <p className="text-xs text-muted mt-1">{zeitraumText}</p>
        </div>
      </div>
      {leiste.length > 0 ? (
        <div className="px-4 pb-4">
          <ZeitraumLeiste monate={leiste} />
        </div>
      ) : null}
      <div className="card-footer">
        <span>Prüfer und Prüfungsart werden mit dem Nachweispaket erfasst.</span>
        <span>
          Phase {ctx.aktivePhase} von {PHASEN.length}
        </span>
      </div>
    </section>
  );
}

function Nachweispaket() {
  return (
    <section className="card" aria-labelledby="tcms-nachweispaket">
      <div className="card-header">
        <h3 id="tcms-nachweispaket" className="text-sm font-semibold text-primary">
          Nachweispaket
        </h3>
        <span className="badge-gray">folgt</span>
      </div>
      <div className="p-4 space-y-3">
        <ul className="list-disc pl-5 text-xs text-secondary space-y-1">
          <li>Index mit Hashes (ZIP und PDF-Index)</li>
          <li>freigegebene Beschreibungsversion</li>
          <li>Risikoinventar und Kontrollmatrix zum Stichtag</li>
          <li>Durchführungen mit Nachweisen</li>
          <li>Feststellungen und Maßnahmen</li>
          <li>Audit-Auszug mit Prüfung der Hashkette</li>
        </ul>
        <button
          type="button"
          className="btn-primary w-full"
          disabled
          aria-describedby="tcms-nachweispaket-hinweis"
        >
          <Download className="h-4 w-4" aria-hidden="true" /> Nachweispaket erzeugen
        </button>
        <p id="tcms-nachweispaket-hinweis" className="hint">
          Der Export folgt in einer späteren Ausbaustufe. Lücken blockieren den Export nicht, sie
          erscheinen im Paket.
        </p>
      </div>
    </section>
  );
}

function LueckeZeile({ l, begonnen, href }: { l: Luecke; begonnen: boolean; href: string }) {
  const na = !!l.nurZeitraum && !begonnen;
  const punkt = na ? 'dot-gray' : l.anzahl === 0 ? 'dot-green' : l.rot ? 'dot-red' : 'dot-amber';
  return (
    <li className="border-b border-default last:border-b-0">
      <Link href={href} className="flex items-center gap-3 px-6 py-2.5 hover:bg-surface-raised">
        <span className={`status-dot ${punkt}`} aria-hidden="true" />
        <span className={`grow text-sm ${na || l.anzahl === 0 ? 'text-secondary' : ''}`}>
          {l.text}
          {!na && l.codes?.length ? (
            <span className="block text-xs text-muted">{l.codes.join(', ')}</span>
          ) : null}
        </span>
        <span className="font-mono text-sm">
          {na ? (
            <>
              <span aria-hidden="true">n. a.</span>
              <span className="sr-only">nicht anwendbar</span>
            </>
          ) : (
            l.anzahl
          )}
        </span>
        <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />
      </Link>
    </li>
  );
}

function Lueckenanalyse({ ctx, link }: Ansicht) {
  const begonnen = zeitraumBegonnen(ctx);
  const luecken = lueckenAus(ctx);
  const gesamt = luecken.filter((l) => !(l.nurZeitraum && !begonnen) && l.anzahl > 0).length;
  return (
    <section className="card" aria-labelledby="tcms-luecken">
      <div className="card-header">
        <h3 id="tcms-luecken" className="text-sm font-semibold text-primary">
          Lückenanalyse
        </h3>
        {gesamt > 0 ? (
          <span className="badge-yellow">Lücken ({gesamt})</span>
        ) : (
          <span className="badge-green">dokumentiert</span>
        )}
      </div>
      <ul>
        {luecken.map((l) => (
          <LueckeZeile key={l.text} l={l} begonnen={begonnen} href={link(l.ziel)} />
        ))}
      </ul>
      <div className="card-footer">
        <span>
          Zählung zum Stand {isoDatumText(ctx.stand)}; „n. a.“, solange der Wirksamkeitszeitraum
          nicht begonnen hat. Zahlen des Zeitraums liefert das Tax-CMS.
        </span>
      </div>
    </section>
  );
}

function Grundelemente({ ctx, link }: Ansicht) {
  return (
    <section className="card" aria-labelledby="tcms-grundelemente-pruefung">
      <div className="card-header">
        <h3 id="tcms-grundelemente-pruefung" className="text-sm font-semibold text-primary">
          Sieben Grundelemente
        </h3>
      </div>
      <ul>
        {ctx.grundelemente.map((g) => (
          <li key={g.key} className="border-b border-default last:border-b-0">
            <Link
              href={link(GRUNDELEMENT_ZIEL[g.key] ?? 'beschreibung')}
              className="flex items-start gap-3 px-6 py-2.5 hover:bg-surface-raised"
            >
              <span className={`kpi-chip ${g.luecken.length ? 'chip-amber' : 'chip-green'}`}>
                <KatalogIcon name={g.icon} />
              </span>
              <span className="grow">
                <span className="block text-sm text-primary">{g.titel}</span>
                {g.luecken.length ? (
                  <span className="block text-xs text-muted mt-0.5">{g.luecken.join(' · ')}</span>
                ) : null}
              </span>
              {g.luecken.length ? (
                <span className="badge-yellow shrink-0">Lücken ({g.luecken.length})</span>
              ) : (
                <span className="text-xs text-muted shrink-0">dokumentiert</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Beschreibungen({ ctx, link, namen }: Ansicht & { namen: TcmsNamen }) {
  const freigegeben = ctx.beschreibungen.filter((b) => b.freigegebenAm !== null);
  return (
    <section className="card" aria-labelledby="tcms-beschreibungen">
      <div className="card-header">
        <h3 id="tcms-beschreibungen" className="text-sm font-semibold text-primary">
          Freigegebene Beschreibungsversionen
        </h3>
        <Link href={link('beschreibung')} className="text-xs text-muted">
          CMS-Beschreibung →
        </Link>
      </div>
      {freigegeben.length === 0 ? (
        <TcmsLeer
          icon={FileText}
          text="Noch keine Version durch die gesetzlichen Vertreter freigegeben."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Freigegebene Versionen der CMS-Beschreibung</caption>
            <thead>
              <tr>
                <th scope="col" className="th">
                  Version
                </th>
                <th scope="col" className="th">
                  Freigegeben
                </th>
                <th scope="col" className="th">
                  Snapshot
                </th>
              </tr>
            </thead>
            <tbody>
              {[...freigegeben].reverse().map((b) => (
                <tr key={b.id} className="border-t border-default">
                  <td className="px-6 py-2">
                    <span className="font-medium">v{b.nummer}</span>{' '}
                    <span className={b.status === 'FREIGEGEBEN' ? 'badge-green' : 'badge-gray'}>
                      {b.status === 'FREIGEGEBEN' ? 'freigegeben' : 'abgelöst'}
                    </span>
                  </td>
                  <td className="px-6 py-2">
                    <span className="block">{namen.name(b.freigegebenVon)}</span>
                    <span className="block text-xs text-muted">{isoZeitText(b.freigegebenAm)}</span>
                  </td>
                  <td className="px-6 py-2">
                    {b.snapshotSha256 ? (
                      <span className="badge-gray gap-1">
                        <Lock className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">SHA-256 </span>
                        <HashKurz wert={b.snapshotSha256} />
                      </span>
                    ) : (
                      <span className="text-xs text-muted">kein Snapshot</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-footer">
        <span>Ein Hash bindet Inhalte, er authentifiziert keine Person.</span>
      </div>
    </section>
  );
}

function ZeitraumDurchfuehrungen({ ctx }: Ansicht) {
  const zr = ctx.zeitraum;
  return (
    <section className="card" aria-labelledby="tcms-zeitraum-durchfuehrungen">
      <div className="card-header">
        <h3 id="tcms-zeitraum-durchfuehrungen" className="text-sm font-semibold text-primary">
          Durchführungen im Zeitraum
        </h3>
      </div>
      {zr ? (
        <div className="p-4">
          <dl className="grid grid-cols-2 gap-3">
            {(
              [
                [zr.relevante, 'fällig gewordene Durchführungen'],
                [zr.ohneBefund + zr.mitBefund, 'abgeschlossen und gegengezeichnet'],
                [zr.ohneBefund, 'abgeschlossen – ohne Befund'],
                [zr.mitBefund, 'abgeschlossen – mit Befund'],
                [zr.offen, 'noch offen'],
                [zr.ohneGegenzeichnung, 'warten auf Gegenzeichnung'],
                [zr.nachweise, 'Nachweise dokumentiert'],
                [zr.entfallen, 'entfallen (zählen nicht als „ohne Befund“)'],
              ] as const
            ).map(([wert, label]) => (
              <div
                key={label}
                className="flex flex-col-reverse rounded-lg border border-default p-3"
              >
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="text-xl font-bold font-mono text-primary">{wert}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted mt-3">
            Ein Kontrollergebnis ist die Angabe der durchführenden Person; die Gegenzeichnung belegt
            die Vier-Augen-Handlung, nicht die materielle Richtigkeit.
          </p>
        </div>
      ) : (
        <TcmsLeer icon={FileSearch} text="Der Wirksamkeitszeitraum ist noch nicht festgelegt." />
      )}
    </section>
  );
}

export default async function TcmsPruefungPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SuchParameter>;
}) {
  const { id } = await params;
  const seite = await tcmsMandantSeite(id);
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;

  const kontext = await tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, {
    query: standQuery(await searchParams),
  });
  const geladen = auswertenKontext(seite.basis, kontext, FileSearch);
  if (!geladen.ok) return geladen.anzeige;
  const { ctx } = geladen;
  const stand = standFuerLinks(ctx);
  const ansicht: Ansicht = { ctx, link: (pfad) => mitStand(`${seite.basis}/${pfad}`, stand) };
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(ctx.beschreibungen.map((b) => b.freigegebenVon)),
  );

  return (
    <>
      <TcmsKopf
        daten={kopfDaten(ctx)}
        titel={<h2 className="text-lg font-semibold text-primary mr-2">Prüfungsvorbereitung</h2>}
      />
      <TcmsPflichthinweis />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mt-4">
        <Gegenstand {...ansicht} />
        <Nachweispaket />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
        <Lueckenanalyse {...ansicht} />
        <Grundelemente {...ansicht} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
        <Beschreibungen {...ansicht} namen={namen} />
        <ZeitraumDurchfuehrungen {...ansicht} />
      </div>
    </>
  );
}
