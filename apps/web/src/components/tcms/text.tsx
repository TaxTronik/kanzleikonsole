// =============================================================================
// Richtungsisolierte Anzeige von Texten aus dem Tax-CMS (TCMS Stufe 3,
// s9-Restpunkt; kk-tcms-qual).
//
// Der Vertrag lässt in Freitexten die Richtungsmarken LRM, RLM und ALM zu und
// liest gespeicherte Texte tolerant (Altbestand, nur Länge). Ohne Isolation
// wirkt eine solche Marke über den Text hinaus: Sie ordnet Satzzeichen,
// Nummern und Labels der umgebenden Zeile um (etwa „F-2026-001 · <Titel> ·
// offen“). Jeder Text aus dem Dienst – Titel, Namen, Freitexte, Begründungen,
// Dateinamen – erscheint deshalb nur über diese Bausteine:
//   - `TcmsText` inline als `<bdi>` (eigene Richtung, keine Wirkung nach außen),
//   - `TcmsTextBlock` für Absätze und Zellen mit `dir="auto"` (Richtung aus dem
//     ersten starken Zeichen, ebenfalls isoliert).
//   - `TCMS_TEXT_ISOLIERT` (`dir="auto"`) für ein vorhandenes Element, das nur
//     den Text trägt (Badge, Zelle, Link, `<option>` – dort ist `<bdi>` nicht
//     erlaubt).
// In Attributen (`title`, `aria-label`) bleibt der Text roh.
// Die Seitentests prüfen die Renderer mit markierten Antworten des Dienstes
// (`… – Richtungsisolation`, Prüfhilfe src/__tests__/tcms-isolation.ts); die
// Bausteine selbst prüft components/tcms/__tests__/isolation.test.tsx.
// =============================================================================

import { Fragment, type ReactNode } from 'react';

/** Text aus dem Tax-CMS innerhalb einer Zeile (`<bdi>`). */
export function TcmsText({ children }: { children: ReactNode }) {
  return <bdi>{children}</bdi>;
}

/** Liste von Texten (z. B. Kanäle), jeder für sich isoliert, mit Trenner. */
export function TcmsTextListe({
  werte,
  trenner = ', ',
}: {
  werte: readonly string[];
  trenner?: string;
}) {
  return (
    <>
      {werte.map((wert, i) => (
        <Fragment key={`${i}-${wert}`}>
          {i > 0 ? trenner : null}
          <bdi>{wert}</bdi>
        </Fragment>
      ))}
    </>
  );
}

type BlockElement = 'p' | 'div' | 'span' | 'dd' | 'dt' | 'td' | 'li' | 'blockquote' | 'h3' | 'h4';

/** Absatz oder Zelle mit Text aus dem Tax-CMS (`dir="auto"`). */
export function TcmsTextBlock({
  als: Element = 'p',
  className,
  children,
}: {
  als?: BlockElement;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Element dir="auto" className={className}>
      {children}
    </Element>
  );
}

/** Attribut für ein Element, das nur Text aus dem Tax-CMS trägt (auch `<option>`). */
export const TCMS_TEXT_ISOLIERT = { dir: 'auto' } as const;
