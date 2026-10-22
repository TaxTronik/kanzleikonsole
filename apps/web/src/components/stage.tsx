import type { ReactNode } from 'react';
import { Check } from 'lucide-react';

// =============================================================================
// Stage — ein Schritt eines geführten Prozesses als Karte: Nummernbadge
// (done = Häkchen, active = Brand, open = neutral), Titel/Sub, rechts
// Status-Pill und/oder eine Aktion. Der Inhalt bleibt unverändert — die
// Stage ist reines Framing (Styling in globals.css).
// =============================================================================

export function Stage({
  num,
  title,
  sub,
  state = 'open',
  badge,
  action,
  bodyId,
  collapsed = false,
  children,
}: {
  /** Schritt-Nummer (wird bei state='done' durch ein Häkchen ersetzt).
   *  Optional: ohne Nummer reine Titel-Stage (z. B. zwei Karten in einer Stufe). */
  num?: number;
  title: string;
  sub?: string;
  state?: 'done' | 'active' | 'open';
  /** Rechte Seite des Headers: Status-Pill (z. B. <span className="badge …">). */
  badge?: ReactNode;
  /** Rechte Seite des Headers: Aktions-Button/Link (nach dem Badge). */
  action?: ReactNode;
  /** id des Inhalts, damit ein Auf-/Zuklapp-Button ihn per aria-controls benennt. */
  bodyId?: string;
  /** Zugeklappt: nur der Kopf ist sichtbar; der Inhalt bleibt im DOM (hidden),
   *  damit Formularzustand und laufende Eingaben erhalten bleiben. */
  collapsed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`card stage ${state}`}>
      <div className="stage-head">
        {num !== undefined && (
          <span className="num" aria-hidden>
            {state === 'done' ? <Check className="h-3.5 w-3.5" /> : num}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="stage-title" id={bodyId ? `${bodyId}-title` : undefined}>
            {title}
          </div>
          {sub ? <div className="stage-sub">{sub}</div> : null}
        </div>
        {badge}
        {action}
      </div>
      {/* @container: Raster im Inhalt richten sich nach der Breite der Stufe,
          nicht nach dem Fenster (Sidebar, Einstellungsnavigation, große Schrift). */}
      <div id={bodyId} className="stage-body with-rule @container" hidden={collapsed}>
        {children}
      </div>
    </div>
  );
}
