// =============================================================================
// Tabelle des Risikoinventars (TCMS Stufe 3, portiert aus der Demo
// staff/clients/[id]/tcms/risiken/page.tsx). Reine Anzeige der Antwort von
// `GET …/risiken`; Kontrollen (Anzahl, Schlüsselkontrollen, Hinweis „Klasse
// erhöht“) aus dem Kontext, Namen aus der kanzleikonsole.
// =============================================================================

import Link from 'next/link';
import { Flag, KeyRound, Pencil, RefreshCw } from 'lucide-react';
import type { KontextAntwort, RisikoEintrag } from '@taxtronik/tcms-contract';
import { KLASSE_LABEL, KLASSE_RANG, type Klasse } from '@taxtronik/tcms-domain';
import type { TcmsNamen } from '@/server/tcms/namen';
import { GtBadge, KlasseBadge } from '../badges';
import { isoDatumText } from '../format';
import {
  AKZEPTANZ_STATUS_KURZ,
  AKZEPTANZ_STATUS_LABEL,
  kurzName,
  RISIKO_FREIGABE_BADGE,
  RISIKO_FREIGABE_LABEL,
} from './labels';
import { TcmsText } from '@/components/tcms/text';

type Kontrolle = KontextAntwort['kontrollen'][number];

function NettoZelle({
  r,
  sicht,
  notiz,
}: {
  r: RisikoEintrag;
  sicht: 'DESIGN' | 'BETRIEB';
  notiz?: string | null;
}) {
  const b = r.bewertung;
  const wirksam = sicht === 'DESIGN' ? b.wirksamDesign : b.wirksamBetrieb;
  const berechnet = sicht === 'DESIGN' ? b.nettoDesign : b.nettoBetrieb;
  const uebersteuert = sicht === 'DESIGN' ? b.uebersteuertDesign : b.uebersteuertBetrieb;
  const freigegeben = r.uebersteuerungen.find(
    (u) => u.sicht === sicht && u.status === 'FREIGEGEBEN',
  );
  const beantragt = r.uebersteuerungen.some((u) => u.sicht === sicht && u.status === 'BEANTRAGT');
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="inline-flex flex-wrap gap-1">
        <KlasseBadge klasse={wirksam} title={berechnet.erklaerung} />
        {uebersteuert ? (
          <span
            className="badge-yellow gap-1"
            title={`berechnet: ${KLASSE_LABEL[berechnet.klasse]}${
              freigegeben
                ? ` · freigegeben ${isoDatumText(freigegeben.entschiedenAm)} · „${freigegeben.begruendung}“`
                : ''
            }`}
          >
            <Pencil className="h-3 w-3" aria-hidden="true" /> übersteuert
          </span>
        ) : null}
        {beantragt ? (
          <span
            className="badge-purple"
            title="Übersteuerung beantragt – wartet auf eine zweite Person"
          >
            beantragt
          </span>
        ) : null}
      </span>
      {uebersteuert ? (
        <span className="text-xs text-muted">berechnet: {KLASSE_LABEL[berechnet.klasse]}</span>
      ) : null}
      {notiz ? <span className="text-xs text-red-700">{notiz}</span> : null}
    </div>
  );
}

/**
 * Erklärung, warum Netto (Betrieb) über Netto (Design) liegt: angemessen
 * beurteilte Kontrollen, deren Betrieb überfällig oder mit Befund ist (beides
 * Angaben des Dienstes). Nur Anzeige – die Klasse rechnet der Dienst.
 */
export function klasseErhoehtNotiz(r: RisikoEintrag, kontrollen: readonly Kontrolle[]) {
  const b = r.bewertung;
  if (KLASSE_RANG[b.nettoBetrieb.klasse] <= KLASSE_RANG[b.nettoDesign.klasse]) return null;
  const ausfall = kontrollen
    .filter(
      (k) =>
        k.design === 'ANGEMESSEN' && (k.betrieb === 'UEBERFAELLIG' || k.betrieb === 'MIT_BEFUND'),
    )
    .map((k) => `${k.code} ${k.betrieb === 'UEBERFAELLIG' ? 'überfällig' : 'mit Befund'}`);
  return ausfall.length ? `Klasse erhöht: ${ausfall.join(', ')}` : null;
}

export interface InventarZeilenOptionen {
  /** Auswahlspalte für den Freigabeschritt anzeigen. */
  mitAuswahl: boolean;
  /** Ob ein Risiko auswählbar ist; Text = Grund, warum nicht. */
  auswahl: (r: RisikoEintrag) => true | string;
  /** Link zum Detailbereich des Risikos (Filter und Stichtag bleiben). */
  detailHref: (r: RisikoEintrag) => string;
  ausgewaehlt: string | null;
}

export function RisikoTabelle({
  risiken,
  kontrollen,
  appetit,
  betriebAktiv,
  namen,
  optionen,
}: {
  risiken: readonly RisikoEintrag[];
  kontrollen: readonly Kontrolle[];
  appetit: Klasse;
  betriebAktiv: boolean;
  namen: TcmsNamen;
  optionen: InventarZeilenOptionen;
}) {
  const kontrolleJe = new Map(kontrollen.map((k) => [k.id, k]));
  const massgeblich = betriebAktiv ? 'Betrieb' : 'Design';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">
          Risikoinventar – {risiken.length} Risiken, sortiert nach Risikoappetit und Bruttoklasse
        </caption>
        <thead>
          <tr>
            {optionen.mitAuswahl ? (
              <th scope="col" className="th">
                <span className="sr-only">Auswahl</span>
              </th>
            ) : null}
            <th scope="col" className="th">
              ID
            </th>
            <th scope="col" className="th">
              Risiko
            </th>
            <th scope="col" className="th">
              Gruppe
            </th>
            <th scope="col" className="th" title="Governance-Typ">
              GT
            </th>
            <th scope="col" className="th">
              Brutto
            </th>
            <th scope="col" className="th" title="Zugeordnete Kontrollen">
              Kontrollen
            </th>
            <th scope="col" className="th">
              Netto Design
            </th>
            <th scope="col" className="th">
              Netto Betrieb
            </th>
            <th
              scope="col"
              className="th"
              title={`Netto ${massgeblich} über Risikoappetit (${KLASSE_LABEL[appetit]})`}
            >
              <Flag className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">Über Risikoappetit</span>
            </th>
            <th scope="col" className="th">
              Verantwortlich
            </th>
            <th scope="col" className="th">
              Status
            </th>
            <th scope="col" className="th th-right" title="Offene Ereignisfolgen zum Risiko">
              Ereignisse
            </th>
          </tr>
        </thead>
        <tbody>
          {risiken.map((r) => {
            const b = r.bewertung;
            const ks = r.kontrollIds.flatMap((id) => {
              const k = kontrolleJe.get(id);
              return k ? [k] : [];
            });
            const schluessel = ks.filter((k) => k.schluessel).length;
            const akzeptanz = r.akzeptanzen[0];
            const auswahl = optionen.auswahl(r);
            const href = optionen.detailHref(r);
            const verantwortlich = namen.name(r.ownerId);
            const ausgewaehlt = optionen.ausgewaehlt === r.id;
            return (
              <tr
                key={r.id}
                className={`border-t border-default align-top ${ausgewaehlt ? 'bg-surface-raised' : ''}`}
                aria-current={ausgewaehlt ? 'true' : undefined}
              >
                {optionen.mitAuswahl ? (
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      name="risikoIds"
                      value={r.id}
                      disabled={auswahl !== true}
                      aria-label={`${r.code} auswählen`}
                      title={auswahl === true ? undefined : auswahl}
                      aria-describedby={auswahl === true ? undefined : `risiko-sperre-${r.id}`}
                    />
                    {/* Sperrgrund auch für Screenreader, nicht nur als Tooltip (a11y, Bereich B). */}
                    {auswahl === true ? null : (
                      <span id={`risiko-sperre-${r.id}`} className="sr-only">
                        {auswahl}
                      </span>
                    )}
                  </td>
                ) : null}
                <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                  <Link href={href} scroll={false} className="text-primary hover:underline">
                    {r.code}
                  </Link>
                </td>
                <td className="px-3 py-2 min-w-[12rem]">
                  <Link
                    href={href}
                    scroll={false}
                    className="font-medium text-primary hover:underline"
                  >
                    <TcmsText>{r.titel}</TcmsText>
                  </Link>
                  {r.kern ? <span className="text-xs text-muted"> · Kern</span> : null}
                </td>
                <td className="px-3 py-2">
                  <span className="badge-gray" title={r.gruppeLabel}>
                    {r.gruppe}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <GtBadge gt={r.gt} />
                </td>
                <td className="px-3 py-2">
                  <KlasseBadge klasse={b.brutto.klasse} title={b.brutto.erklaerung} />
                </td>
                <td className="px-3 py-2">
                  {r.kontrollIds.length > 0 ? (
                    <span
                      className="inline-flex items-center gap-1"
                      title={ks.map((k) => k.code).join(', ')}
                    >
                      <span className="font-mono">{r.kontrollIds.length}</span>
                      {schluessel > 0 ? (
                        <>
                          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="sr-only">
                            , davon {schluessel} Schlüsselkontrolle{schluessel === 1 ? '' : 'n'}
                          </span>
                        </>
                      ) : null}
                    </span>
                  ) : (
                    <span className="badge-red" title="Keine Kontrolle zugeordnet">
                      0<span className="sr-only"> – keine Kontrolle zugeordnet</span>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <NettoZelle r={r} sicht="DESIGN" />
                </td>
                <td className="px-3 py-2 max-w-[11rem]">
                  <NettoZelle r={r} sicht="BETRIEB" notiz={klasseErhoehtNotiz(r, ks)} />
                </td>
                <td className="px-3 py-2">
                  {r.ueberAppetit ? (
                    <span
                      className="inline-flex items-center gap-1 text-red-700"
                      title={`Netto ${massgeblich} ${KLASSE_LABEL[r.netto]} über Risikoappetit ${KLASSE_LABEL[appetit]}${
                        akzeptanz ? ` · ${AKZEPTANZ_STATUS_LABEL[akzeptanz.status]}` : ''
                      }`}
                    >
                      <Flag className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="sr-only">über Appetit</span>
                      {akzeptanz ? (
                        <span className="text-xs">{AKZEPTANZ_STATUS_KURZ[akzeptanz.status]}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted">
                      <span aria-hidden="true">·</span>
                      <span className="sr-only">im Appetit</span>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap" title={verantwortlich}>
                  {namen.bekannt(r.ownerId) ? kurzName(verantwortlich) : verantwortlich}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="flex flex-col items-start gap-1">
                    <span className={RISIKO_FREIGABE_BADGE[r.freigabe]}>
                      {RISIKO_FREIGABE_LABEL[r.freigabe]}
                    </span>
                    {r.hinweise.length > 0 ? (
                      <span
                        className="badge-yellow gap-1"
                        title={r.hinweise.map((h) => h.text).join('\n')}
                      >
                        <RefreshCw className="h-3 w-3" aria-hidden="true" /> neu bewerten
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {r.offeneEreignisse > 0 ? (
                    r.offeneEreignisse
                  ) : (
                    <span className="text-muted">
                      <span aria-hidden="true">·</span>
                      <span className="sr-only">keine</span>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
