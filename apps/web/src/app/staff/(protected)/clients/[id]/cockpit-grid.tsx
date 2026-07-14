import { type ReactNode } from 'react';
import type { ClientBlockKey, ClientGridItem } from '@/server/settings/client-layout-shared';

/**
 * Read-only Cockpit-Grid für die Mandantendetail-Seite. Rendert die Blöcke
 * über natives CSS-Grid in den Positionen, die der Admin im ACP konfiguriert
 * hat — KEIN react-grid-layout im Display-Modus, weil dessen feste rowHeight
 * für stark unterschiedliche Inhalte (1-Zeilen-Ansprechpartner vs. Dokument-
 * Tabelle) hässliche Lücken produziert.
 *
 * Strategie:
 *   - 12-Spalten-Grid mit `grid-template-columns: repeat(12, 1fr)`
 *   - Jeder Block bekommt `grid-column: ${x+1} / span ${w}`
 *   - Reihen-Tracks werden auf `auto` gestellt; `h` wird ignoriert und durch
 *     den tatsächlichen Inhalt bestimmt — kein "Slot-Padding" mehr
 *   - Reihenfolge der Items steuert die Render-Reihenfolge im DOM; durch
 *     `grid-row: span 1` und `grid-auto-flow: dense` packt CSS-Grid die
 *     Karten kompakt entsprechend ihrer Position
 *
 * Edit-Mode im ACP-Editor nutzt weiterhin react-grid-layout für Drag/Resize.
 * Hier brauchen wir den Overhead und die fixen Höhen nicht.
 */
export function CockpitGrid({
  items,
  blocks,
}: {
  items: ClientGridItem[];
  blocks: Record<ClientBlockKey, ReactNode>;
}) {
  // Items in Render-Reihenfolge: erst nach y, dann nach x — so dass das Grid
  // die Karten von oben nach unten und links nach rechts packt.
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const visible = sorted.filter((it) => blocks[it.id] !== null && blocks[it.id] !== undefined);

  return (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
        gridAutoFlow: 'row dense',
      }}
    >
      {visible.map((it) => (
        <div
          key={it.id}
          style={{
            gridColumn: `${it.x + 1} / span ${it.w}`,
          }}
        >
          {blocks[it.id]}
        </div>
      ))}
    </div>
  );
}
