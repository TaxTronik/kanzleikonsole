// =============================================================================
// Nachweise einer Kontrolldurchführung als Liste – eine Darstellung für die
// Durchführung der Kanzlei (Bereich C, „Nachweise“) und die Kontrollaufgabe im
// Portal (Bereich D, „Anlagen“); Integration TCMS Stufe 3. Beide zeigen
// dieselben Felder der Antwort (`NachweisSchema` aus den gemeinsamen
// Aufgabenfeldern des Vertrags): Datei, SHA-256, Sperre, Größe, hochladende
// Person und Zeitpunkt, Anzahl gegenüber der Mindestanzahl der Kontrolle.
//
// Reine Anzeige. Abrufbar ist eine Datei nur über den Link der Seite (Route
// der kanzleikonsole mit SHA-256-Abgleich, server/tcms/route.ts). Kennt die
// Seite den Abgleich mit der Ablage (Kanzlei), zeigt die Liste bei Abweichung
// oder fehlendem Dokument keinen Link; ohne Abgleich (Portal) prüft allein die
// Route. Entfernen und Hochladen kommen als fertige Bedienelemente der Seite.
//
// Dateinamen (RT3B-K-04): angezeigt wird der Name aus der eigenen Ablage
// (`dateinamen`, Titel und Typ des gebundenen Dokuments), nie der Dateiname
// aus der Antwort des Dienstes; fehlt das Dokument, der Dienstwert nach der
// Zeichenregel bereinigt (ohne Steuer-, Format- und Richtungszeichen).
// =============================================================================

import type { ReactNode } from 'react';
import { Download, FileSpreadsheet, FileText, Hash, Lock, TriangleAlert } from 'lucide-react';
import type { DurchfuehrungDetail } from '@taxtronik/tcms-contract';
import { tcmsTextBereinigen } from '@/server/tcms/zeichen';
import { HashKurz } from '../badges';
import { isoZeitText } from '../format';
import { fmtGroesse } from './werte';
import { TcmsText } from '@/components/tcms/text';

/** Nachweis aus den gemeinsamen Aufgabenfeldern (Durchführung und Kontrollaufgabe). */
export type Nachweis = DurchfuehrungDetail['nachweise'][number];

/** Abgleich eines Nachweises mit der Ablage (server/tcms/durchfuehrung/verweis.ts). */
export type NachweisZustand = 'OK' | 'ABWEICHUNG' | 'FEHLT';

/**
 * Anzeigename eines Nachweises (RT3B-K-04): Name aus der eigenen Ablage, sonst
 * der Dateiname des Dienstes nach der Zeichenregel bereinigt.
 */
export function nachweisAnzeigename(
  n: Pick<Nachweis, 'id' | 'dateiname'>,
  dateinamen?: ReadonlyMap<string, string>,
): string {
  return dateinamen?.get(n.id) ?? (tcmsTextBereinigen(n.dateiname, 'DATEINAME', 255) || 'Datei');
}

function DateiIcon({ name, mime }: { name: string; mime: string }) {
  const tabelle =
    /\.(xlsx?|csv|ods)$/i.test(name) || mime.includes('spreadsheet') || mime === 'text/csv';
  const Icon = tabelle ? FileSpreadsheet : FileText;
  return <Icon className="h-5 w-5 mt-0.5 shrink-0 text-muted" aria-hidden="true" />;
}

export interface NachweisListeProps {
  /** ID der Überschrift (`aria-labelledby` der Karte). */
  id: string;
  /** „Nachweise“ (Kanzlei) bzw. „Anlagen“ (Portal). */
  titel: string;
  /** Überschriftenebene der Seite (Kanzlei unter `h2`, Portal unter `h1`). */
  ebene: 'h2' | 'h3';
  nachweise: readonly Nachweis[];
  /** Mindestanzahl der Kontrolle (`kontrolle.mindestNachweise`). */
  mindest: number;
  /** Nachweisanforderung der Kontrolle (`kontrolle.nachweis`). */
  anforderung: string;
  /** Nach dem Stichtag angehängte, ausgeblendete Dateien (`nachweiseAusgeblendet`). */
  ausgeblendet: number;
  namen: { name(id: string | null | undefined): string };
  /** Link zum Abruf über die Route der kanzleikonsole. */
  abrufHref: (nachweisId: string) => string;
  /** Abgleich mit der Ablage; ohne Angabe entscheidet allein die Route beim Abruf. */
  abgleich?: ReadonlyMap<string, NachweisZustand>;
  /** Dateinamen aus der eigenen Ablage je Nachweis-ID (RT3B-K-04, `nachweisAnzeigename`). */
  dateinamen?: ReadonlyMap<string, string>;
  /** Bis wann ungesperrte Dateien änderbar sind („Einreichen“ bzw. „Übermitteln“). */
  aenderbarBis: string;
  /** Bedienelement zum Entfernen einer Datei oder null (Recht und Sperre laut Dienst). */
  entfernen: (n: Nachweis) => ReactNode | null;
  /** Hochladen/Auswählen oder Hinweis, warum nichts angehängt werden kann. */
  fuss: ReactNode;
}

export function NachweisListe({
  id,
  titel,
  ebene,
  nachweise,
  mindest,
  anforderung,
  ausgeblendet,
  namen,
  abrufHref,
  abgleich,
  dateinamen,
  aenderbarBis,
  entfernen,
  fuss,
}: NachweisListeProps) {
  const Ueberschrift = ebene;
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-header">
        <Ueberschrift id={id} className="text-sm font-semibold text-primary">
          {titel}
        </Ueberschrift>
        <span className="flex flex-wrap items-center gap-2">
          {mindest > 0 ? (
            <span
              className={nachweise.length >= mindest ? 'badge-green' : 'badge-yellow'}
              title={`Erwartet: ${anforderung}`}
            >
              {nachweise.length} von mind. {mindest}
            </span>
          ) : null}
          <span className="badge-gray">
            {nachweise.length === 1 ? '1 Datei' : `${nachweise.length} Dateien`}
          </span>
        </span>
      </div>
      {nachweise.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted">
          Noch keine {titel} hochgeladen. Erwartet: <TcmsText>{anforderung}</TcmsText>.
        </p>
      ) : (
        <ul>
          {nachweise.map((n) => {
            const zustand: NachweisZustand = abgleich ? (abgleich.get(n.id) ?? 'FEHLT') : 'OK';
            const href = zustand === 'OK' ? abrufHref(n.id) : null;
            const name = nachweisAnzeigename(n, dateinamen);
            const knopf = entfernen(n);
            return (
              <li
                key={n.id}
                className="flex flex-wrap items-start gap-3 px-6 py-3 border-b border-default last:border-b-0"
              >
                <DateiIcon name={name} mime={n.mime} />
                <div className="grow min-w-0">
                  {href ? (
                    <a
                      href={href}
                      className="text-sm font-medium text-primary underline-offset-2 hover:underline break-all"
                    >
                      <TcmsText>{name}</TcmsText>
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-primary break-all">
                      <TcmsText>{name}</TcmsText>
                    </span>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="badge-gray gap-1" title="SHA-256 des Inhalts">
                      {n.gesperrt ? (
                        <Lock className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <Hash className="h-3 w-3" aria-hidden="true" />
                      )}
                      {n.gesperrt ? 'gesperrt · ' : ''}
                      <HashKurz wert={n.sha256} />
                    </span>
                    {!n.gesperrt ? (
                      <span className="badge-yellow">bis zum {aenderbarBis} änderbar</span>
                    ) : null}
                    {zustand === 'ABWEICHUNG' ? (
                      <span className="badge-red gap-1">
                        <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                        Abweichung zur Ablage – nicht abrufbar
                      </span>
                    ) : zustand === 'FEHLT' ? (
                      <span className="badge-gray">Dokument in der Ablage nicht verfügbar</span>
                    ) : null}
                    <span className="text-xs text-muted">
                      {fmtGroesse(n.groesse)} · {namen.name(n.hochgeladenVon)} ·{' '}
                      {isoZeitText(n.hochgeladenAm)}
                    </span>
                  </div>
                  {zustand === 'ABWEICHUNG' ? (
                    <p className="hint">
                      Die gespeicherte Datei stimmt nicht mit dem Verweis im Tax-CMS überein
                      (SHA-256 oder Größe). Sie wird nicht ausgeliefert; bitte die Kanzleiverwaltung
                      informieren.
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-start gap-2">
                  {href ? (
                    <a
                      className="btn-secondary text-xs py-1 inline-flex items-center gap-1"
                      href={href}
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" /> Herunterladen
                      <span className="sr-only">
                        {' '}
                        <TcmsText>{name}</TcmsText>
                      </span>
                    </a>
                  ) : null}
                  {knopf}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {ausgeblendet > 0 ? (
        <p className="px-6 py-3 text-xs text-muted border-t border-default">
          {ausgeblendet} später hochgeladene Datei(en) zum Stichtag ausgeblendet.
        </p>
      ) : null}
      <div className="px-6 py-4 border-t border-default">{fuss}</div>
    </section>
  );
}
