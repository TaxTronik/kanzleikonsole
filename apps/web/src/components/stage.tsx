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
          <div className="stage-title">{title}</div>
          {sub ? <div className="stage-sub">{sub}</div> : null}
        </div>
        {badge}
        {action}
      </div>
      <div className="stage-body with-rule">{children}</div>
    </div>
  );
}
