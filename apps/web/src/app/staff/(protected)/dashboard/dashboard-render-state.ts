import type { ReactNode } from 'react';
import type { LayoutWidget } from '@/server/dashboard/widgets';

export interface RenderedWidget {
  widget: LayoutWidget;
  node: ReactNode;
}

/**
 * Frisch servergerenderte Nodes sind die Quelle der Wahrheit. Lokale Nodes
 * ueberbruecken nur den Zeitraum zwischen optimistischem Add und dem naechsten
 * Server-Refresh; sobald der Server dieselbe ID liefert, gewinnt dessen Node.
 */
export function dashboardRenderMap(
  fresh: readonly RenderedWidget[],
  optimistic: readonly RenderedWidget[],
): Map<string, ReactNode> {
  const byId = new Map(optimistic.map((rendered) => [rendered.widget.id, rendered.node]));
  for (const rendered of fresh) byId.set(rendered.widget.id, rendered.node);
  return byId;
}
