// =============================================================================
// Liste der Kontrolldurchführungen (TCMS Stufe 3, Bereich C). Reine Anzeige
// der Durchführungen aus `kontextLesen`; Gruppen und Sortierung dienen nur der
// Übersicht, Status und Fälligkeit kommen aus dem Dienst.
// =============================================================================

import Link from 'next/link';
import { ClipboardList, KeyRound } from 'lucide-react';
import type { KontextAntwort } from '@taxtronik/tcms-contract';
import {
  frequenzLabel,
  istAbgeschlossen,
  istOffen,
  PARTEI_LABEL,
  type AnzeigeStatus,
} from '@taxtronik/tcms-domain';
import { AnzeigeBadge } from '@/components/tcms/badges';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import { isoDatumText } from '@/components/tcms/format';
import { TcmsKopf } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import type { TcmsNamen } from '@/server/tcms/namen';
import type { TcmsMandantSeite } from '@/server/tcms/seite';

type Durchfuehrung = KontextAntwort['durchfuehrungen'][number];

/** Höchstzahl angezeigter Zeilen (ältere über den Filter erreichbar). */
export const MAX_ZEILEN = 200;

export const GRUPPEN = [
  { wert: 'offen', label: 'Offen' },
  { wert: 'gegenzeichnung', label: 'Zur Gegenzeichnung' },
  { wert: 'geplant', label: 'Geplant' },
  { wert: 'abgeschlossen', label: 'Abgeschlossen' },
  { wert: 'entfallen', label: 'Entfallen' },
  { wert: 'alle', label: 'Alle' },
] as const;
export type Gruppe = (typeof GRUPPEN)[number]['wert'];

export interface ListenFilter {
  gruppe: Gruppe;
  partei: 'KANZLEI' | 'MANDANT' | null;
  schluessel: boolean;
}

function eins(wert: string | string[] | undefined): string {
  return (Array.isArray(wert) ? wert[0] : wert) ?? '';
}

/** Filter aus der Query; unbekannte Werte fallen auf den Standard zurück. */
export function filterAus(suche: Record<string, string | string[] | undefined>): ListenFilter {
  const g = eins(suche.status);
  const p = eins(suche.partei);
  return {
    gruppe: GRUPPEN.some((x) => x.wert === g) ? (g as Gruppe) : 'offen',
    partei: p === 'KANZLEI' || p === 'MANDANT' ? p : null,
    schluessel: eins(suche.schluessel) === '1',
  };
}

function inGruppe(a: AnzeigeStatus, g: Gruppe): boolean {
  switch (g) {
    case 'offen':
      return istOffen(a);
    case 'gegenzeichnung':
      return a === 'ZUR_GEGENZEICHNUNG';
    case 'geplant':
      return a === 'GEPLANT';
    case 'abgeschlossen':
      return istAbgeschlossen(a);
    case 'entfallen':
      return a === 'ENTFALLEN';
    case 'alle':
      return true;
  }
}

/** Gefilterte und sortierte Durchführungen (offene nach Fälligkeit, sonst neueste zuerst). */
export function durchfuehrungenGefiltert(ctx: KontextAntwort, filter: ListenFilter) {
  const basis = ctx.durchfuehrungen.filter(
    (d) => (!filter.partei || d.partei === filter.partei) && (!filter.schluessel || d.schluessel),
  );
  const anzahl = Object.fromEntries(
    GRUPPEN.map((g) => [g.wert, basis.filter((d) => inGruppe(d.anzeige, g.wert)).length]),
  ) as Record<Gruppe, number>;
  const aufsteigend = filter.gruppe === 'offen' || filter.gruppe === 'gegenzeichnung';
  const alle = basis
    .filter((d) => inGruppe(d.anzeige, filter.gruppe))
    .sort((a, b) => {
      const t = a.faelligAm.localeCompare(b.faelligAm);
      return (aufsteigend ? t : -t) || a.code.localeCompare(b.code, 'de');
    });
  return { zeilen: alle.slice(0, MAX_ZEILEN), gesamt: alle.length, anzahl };
}

export function OhneProgramm({
  seite,
  titel = 'Durchführungen',
}: {
  seite: TcmsMandantSeite;
  titel?: string;
}) {
  return (
    <>
      <h2 className="text-lg font-semibold text-primary mb-3">{titel}</h2>
      <div className="card">
        <TcmsLeer
          icon={ClipboardList}
          text="Für diesen Mandanten ist noch kein Tax-CMS-Programm eingerichtet."
        >
          <Link href={seite.basis} className="btn-secondary">
            Zum Cockpit
          </Link>
        </TcmsLeer>
      </div>
    </>
  );
}

export function DurchfuehrungenListe({
  seite,
  ctx,
  filter,
  namen,
}: {
  seite: TcmsMandantSeite;
  ctx: KontextAntwort;
  filter: ListenFilter;
  namen: TcmsNamen;
}) {
  const { zeilen, gesamt, anzahl } = durchfuehrungenGefiltert(ctx, filter);
  const basis = seite.basis;
  const kontrollen = new Map(ctx.kontrollen.map((k) => [k.id, k]));
  const link = (over: Partial<{ status: string; partei: string; schluessel: string }>) => {
    const q = new URLSearchParams();
    const status = over.status ?? filter.gruppe;
    const partei = over.partei ?? filter.partei ?? '';
    const schluessel = over.schluessel ?? (filter.schluessel ? '1' : '');
    if (status !== 'offen') q.set('status', status);
    if (partei) q.set('partei', partei);
    if (schluessel) q.set('schluessel', schluessel);
    if (ctx.historisch) q.set('stand', ctx.stand);
    const s = q.toString();
    return s ? `${basis}/durchfuehrungen?${s}` : `${basis}/durchfuehrungen`;
  };
  const detail = (id: string) =>
    `${basis}/durchfuehrungen/${encodeURIComponent(id)}${ctx.historisch ? `?stand=${ctx.stand}` : ''}`;

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
        titel={<h2 className="text-lg font-semibold text-primary mr-2">Durchführungen</h2>}
      />
      <TcmsPflichthinweis />

      <nav className="card mt-4 px-4 py-3" aria-label="Filter der Durchführungen">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ul className="flex flex-wrap gap-1.5">
            {GRUPPEN.map((g) => (
              <li key={g.wert}>
                <Link
                  href={link({ status: g.wert })}
                  className={filter.gruppe === g.wert ? 'badge-brand' : 'badge-gray'}
                  aria-current={filter.gruppe === g.wert ? 'page' : undefined}
                >
                  {g.label} ({anzahl[g.wert]})
                </Link>
              </li>
            ))}
          </ul>
          <ul className="flex flex-wrap items-center gap-1.5 text-xs">
            <li className="text-muted">Partei</li>
            {(
              [
                ['', 'Alle'],
                ['KANZLEI', 'Kanzlei'],
                ['MANDANT', 'Mandant'],
              ] as const
            ).map(([wert, label]) => (
              <li key={wert || 'alle'}>
                <Link
                  href={link({ partei: wert })}
                  className={(filter.partei ?? '') === wert ? 'badge-brand' : 'badge-gray'}
                  aria-current={(filter.partei ?? '') === wert ? 'true' : undefined}
                >
                  {label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href={link({ schluessel: filter.schluessel ? '' : '1' })}
                className={`${filter.schluessel ? 'badge-brand' : 'badge-gray'} gap-1`}
                aria-pressed={filter.schluessel}
              >
                <KeyRound className="h-3 w-3" aria-hidden="true" /> nur Schlüsselkontrollen
              </Link>
            </li>
          </ul>
        </div>
      </nav>

      <section className="card mt-4" aria-labelledby="tcms-df-liste">
        <div className="card-header">
          <h3 id="tcms-df-liste" className="text-sm font-semibold text-primary">
            {GRUPPEN.find((g) => g.wert === filter.gruppe)?.label} · {gesamt}{' '}
            {gesamt === 1 ? 'Durchführung' : 'Durchführungen'}
          </h3>
          <span className="text-xs text-muted">
            {filter.gruppe === 'offen' || filter.gruppe === 'gegenzeichnung'
              ? 'nach Fälligkeit'
              : 'neueste Fälligkeit zuerst'}
          </span>
        </div>
        {zeilen.length === 0 ? (
          <TcmsLeer icon={ClipboardList} text="Keine Durchführungen für diesen Filter." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th scope="col" className="th">
                    Kontrolle
                  </th>
                  <th scope="col" className="th">
                    Periode
                  </th>
                  <th scope="col" className="th">
                    Fällig
                  </th>
                  <th scope="col" className="th">
                    Status
                  </th>
                  <th scope="col" className="th th-right">
                    Nachweise
                  </th>
                  <th scope="col" className="th">
                    Zuständig
                  </th>
                </tr>
              </thead>
              <tbody>
                {zeilen.map((d: Durchfuehrung) => {
                  const k = kontrollen.get(d.kontrolleId);
                  const zustaendig =
                    d.anzeige === 'ZUR_GEGENZEICHNUNG'
                      ? `Gegenzeichnung: ${namen.name(d.gegenzeichnerId)}`
                      : istAbgeschlossen(d.anzeige)
                        ? namen.name(d.durchgefuehrtVon ?? d.durchfuehrendId)
                        : namen.name(d.durchfuehrendId);
                  return (
                    <tr key={d.id} className="border-t border-default align-top">
                      <th scope="row" className="px-6 py-3 text-left font-normal">
                        <Link
                          href={detail(d.id)}
                          className="font-medium text-primary hover:underline"
                        >
                          {d.code}
                          <span className="sr-only"> {d.periodeLabel}</span>
                        </Link>
                        {d.schluessel ? (
                          <span className="ml-1 inline-flex text-muted" title="Schlüsselkontrolle">
                            <KeyRound className="h-3 w-3" aria-hidden="true" />
                            <span className="sr-only">Schlüsselkontrolle</span>
                          </span>
                        ) : null}
                        <span className="text-xs text-secondary"> · {d.titel}</span>
                        <div className="text-[11px] text-muted mt-0.5">
                          <span className="font-mono">{d.gt ?? '—'}</span>
                          {k ? ` · ${frequenzLabel(k.frequenz)}` : ''} · {PARTEI_LABEL[d.partei]}
                          {d.ausserplanmaessig ? ' · außerplanmäßig' : ''}
                        </div>
                      </th>
                      <td className="px-6 py-3 whitespace-nowrap">{d.periodeLabel}</td>
                      <td className="px-6 py-3 whitespace-nowrap">{isoDatumText(d.faelligAm)}</td>
                      <td className="px-6 py-3">
                        <AnzeigeBadge status={d.anzeige} />
                      </td>
                      <td className="td-num">
                        <span
                          className={
                            d.mindestNachweise > 0 && d.nachweise < d.mindestNachweise
                              ? 'text-muted'
                              : 'text-primary'
                          }
                        >
                          {d.nachweise}
                          {d.mindestNachweise > 0 ? ` / ${d.mindestNachweise}` : ''}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-xs text-secondary">{zustaendig}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {gesamt > zeilen.length ? (
          <div className="card-footer">
            Angezeigt werden die ersten {zeilen.length} von {gesamt}. Bitte den Filter eingrenzen.
          </div>
        ) : null}
      </section>
    </>
  );
}
