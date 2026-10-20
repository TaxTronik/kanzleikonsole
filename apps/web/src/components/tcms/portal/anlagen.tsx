// =============================================================================
// Anlagen einer Kontrollaufgabe im Portal (TCMS Stufe 3, Bereich D; aus der
// Demo components/durchfuehrung/karten.tsx, NachweiseKarte „portal“).
// Liste aus der Antwort des Dienstes (Verweise mit SHA-256), Abruf über die
// Dokumentauslieferung der kanzleikonsole (Route /api/portal/tcms/aufgaben/
// [id]/anlagen/[nachweisId]), Hochladen und Entfernen als gebundene Aktionen
// der Seite. Darstellung über die gemeinsame NachweisListe (wie die Nachweise
// der Durchführung in der Kanzlei).
// =============================================================================

import type { ReactNode } from 'react';
import { Lock, Trash2 } from 'lucide-react';
import { NachweisListe, nachweisAnzeigename, type Nachweis } from '../durchfuehrung/nachweis-liste';
import { TcmsAktionsKnopf, type TcmsFormAktion } from '../ereignisse/aktionen';

/** Anlage einer Kontrollaufgabe (Nachweis der Durchführung im Vertrag). */
export type AnlageZeile = Nachweis;

export function AnlagenKarte({
  anlagen,
  mindestAnlagen,
  nachweisText,
  ausgeblendet,
  namen,
  dateinamen,
  abruf,
  entfernen,
  upload,
}: {
  anlagen: readonly AnlageZeile[];
  /** Dateinamen aus der eigenen Ablage (für den Mandanten freigegebene Dokumente, RT3B-K-04). */
  dateinamen?: ReadonlyMap<string, string>;
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
    <NachweisListe
      id="tcms-anlagen"
      titel="Anlagen"
      ebene="h2"
      nachweise={anlagen}
      mindest={mindestAnlagen}
      anforderung={nachweisText}
      ausgeblendet={ausgeblendet}
      namen={namen}
      dateinamen={dateinamen}
      abrufHref={abruf}
      aenderbarBis="Übermitteln"
      entfernen={(a) =>
        entfernen[a.id] ? (
          <TcmsAktionsKnopf
            aktion={entfernen[a.id]!}
            className="btn-secondary text-xs py-1"
            bestaetigung={{
              titel: 'Anlage entfernen',
              text: `„${nachweisAnzeigename(a, dateinamen)}“ aus dieser Aufgabe entfernen? Die Datei bleibt in Ihren Dokumenten; der Schritt wird protokolliert.`,
              bestaetigen: 'Entfernen',
              gefahr: true,
            }}
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" /> Entfernen
            <span className="sr-only"> {nachweisAnzeigename(a, dateinamen)}</span>
          </TcmsAktionsKnopf>
        ) : null
      }
      fuss={upload}
    />
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
