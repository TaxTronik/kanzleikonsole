import { describe, expect, it } from 'vitest';
import type { LayoutWidget } from '@/server/dashboard/widgets';
import { dashboardRenderMap, type RenderedWidget } from '../dashboard-render-state';

function rendered(id: string, node: string): RenderedWidget {
  const widget: LayoutWidget = {
    id,
    type: 'kpi_clients',
    x: 0,
    y: 0,
    w: 4,
    h: 4,
  };
  return { widget, node };
}

describe('Dashboard-Render-State', () => {
  it('uebernimmt bei Refresh den frischen Server-Node', () => {
    const result = dashboardRenderMap(
      [rendered('existing', 'fresh')],
      [rendered('existing', 'stale-local')],
    );

    expect(result.get('existing')).toBe('fresh');
  });

  it('behaelt den Node eines optimistisch hinzugefuegten Widgets bis zum Server-Refresh', () => {
    const result = dashboardRenderMap(
      [rendered('existing', 'fresh')],
      [rendered('added', 'optimistic')],
    );

    expect(result.get('existing')).toBe('fresh');
    expect(result.get('added')).toBe('optimistic');
  });
});
