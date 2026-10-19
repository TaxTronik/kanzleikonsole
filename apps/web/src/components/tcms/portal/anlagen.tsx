// =============================================================================
// Anlagen einer Kontrollaufgabe im Portal (TCMS Stufe 3, Bereich D; aus der
// Demo components/durchfuehrung/karten.tsx, NachweiseKarte „portal“).
// Liste aus der Antwort des Dienstes (Verweise mit SHA-256), Abruf über die
// Dokumentauslieferung der kanzleikonsole (Route …/anlagen/[nachweisId]),
// Hochladen und Entfernen als gebundene Aktionen der Seite.
// =============================================================================

import type { ReactNode } from 'react';
import { Download, FileSpreadsheet, FileText, Lock, Trash2 } from 'lucide-react';
import { HashKurz } from '../badges';
import { isoZeitText } from '../format';
import { TcmsAktionsKnopf, type TcmsFormAktion } from '../ereignisse/aktionen';
import { groesseText } from './werte';

export interface AnlageZeile {
  id: string;
  dateiname: string;
  mime: string;
  groesse: number;
  sha256: string;
  gesperrt: boolean;
  hochgeladenVon: string;
  hochgeladenAm: string;
}

function DateiIcon({ a }: { a: AnlageZeile }) {
  const tabelle =
    /\.(xlsx?|csv|ods)$/i.test(a.dateiname) ||
    a.mime.includes('spreadsheet') ||
    a.mime === 'text/csv';
  const Icon = tabelle ? FileSpreadsheet : FileText;
  return <Icon className="h-4 w-4 text-muted shrink-0 mt-0.5" aria-hidden="true" />;
}

export function AnlagenKarte({
  anlagen,
  mindestAnlagen,
  nachweisText,
  ausgeblendet,
  namen,
  abruf,
  entfernen,
  upload,
}: {
  anlagen: readonly AnlageZeile[];
  mindestAnlagen: number;
  nachweisText: string;
  ausgeblendet: number;
  namen: { name(id: string | null | undefined): string };
  /** Link zum Abruf einer Anlage. */
  abruf: (anlageId: string) => string;
  /** Entfernen je Anlage (nur ungesperrte, nur mit Bearbeitungsrecht laut Dienst). */
  entfernen: Readonly<Record<string, TcmsFormAktion>>;
  /** Upload-Formular oder Hinweis, warum nichts hochgeladen werden kann. */
  upload: ReactNode;
}) {
  return (
    <section className="card" aria-labelledby="tcms-anlagen">
      <div className="card-header">
        <h2 id="tcms-anlagen" className="text-sm font-semibold text-primary">
          Anlagen
        </h2>
        <span className="inline-flex flex-wrap gap-2">
          {mindestAnlagen > 0 ? (
            <span
              className={anlagen.length >= mindestAnlagen ? 'badge-green' : 'badge-yellow'}
              title={`Erwartet: ${nachweisText}`}
            >
              {anlagen.length} von mind. {mindestAnlagen}
            </span>
          ) : null}
          <span className="badge-gray">
            {anlagen.length === 1 ? '1 Datei' : `${anlagen.length} Dateien`}
          </span>
        </span>
      </div>
      {anlagen.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted">
          Noch keine Anlagen hochgeladen. Erwartet: {nachweisText}.
        </p>
      ) : (
        <ul>
          {anlagen.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-start gap-3 px-6 py-3 border-b border-default last:border-b-0"
            >
              <DateiIcon a={a} />
              <div className="grow min-w-0">
                <a
                  href={abruf(a.id)}
                  className="text-sm font-medium text-primary hover:underline break-all"
                >
                  {a.dateiname}
                </a>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <span className="badge-gray gap-1" title="SHA-256 des Inhalts">
                    {a.gesperrt ? <Lock className="h-3 w-3" aria-hidden="true" /> : null}
                    {a.gesperrt ? 'gesperrt · ' : ''}
                    <HashKurz wert={a.sha256} />
                  </span>
                  {!a.gesperrt ? (
                    <span className="badge-yellow">bis zum Übermitteln änderbar</span>
                  ) : null}
                  <span className="text-xs text-muted">
                    {groesseText(a.groesse)} · {namen.name(a.hochgeladenVon)} ·{' '}
                    {isoZeitText(a.hochgeladenAm)}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-start gap-2 shrink-0">
                <a href={abruf(a.id)} className="btn-secondary text-xs py-1">
                  <Download className="h-3 w-3" aria-hidden="true" /> Herunterladen
                  <span className="sr-only"> {a.dateiname}</span>
                </a>
                {entfernen[a.id] ? (
                  <TcmsAktionsKnopf
                    aktion={entfernen[a.id]!}
                    className="btn-secondary text-xs py-1"
                    bestaetigung={{
                      titel: 'Anlage entfernen',
                      text: `„${a.dateiname}“ aus dieser Aufgabe entfernen? Die Datei bleibt in Ihren Dokumenten; der Schritt wird protokolliert.`,
                      bestaetigen: 'Entfernen',
                      gefahr: true,
                    }}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" /> Entfernen
                    <span className="sr-only"> {a.dateiname}</span>
                  </TcmsAktionsKnopf>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {ausgeblendet > 0 ? (
        <p className="px-6 py-2 text-xs text-muted border-t border-default">
          {ausgeblendet} später hochgeladene Datei(en) zum Stichtag ausgeblendet.
        </p>
      ) : null}
      <div className="p-4 border-t border-default">{upload}</div>
    </section>
  );
}

/** Hinweis statt Upload (gesperrt, abgeschlossen, historisch, Funktion aus). */
export function AnlagenGesperrt({ text }: { text: string }) {
  return (
    <p className="text-sm text-muted flex items-center gap-2">
      <Lock className="h-4 w-4" aria-hidden="true" /> {text}
    </p>
  );
}
