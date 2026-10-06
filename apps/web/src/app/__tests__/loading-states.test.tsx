// Review-Befund P-07: Unter (protected) streamt der Seiteninhalt hinter einer
// loading-Grenze; bis dahin steht ein zugänglicher Platzhalter.

import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import StaffLoading from '../staff/(protected)/loading';
import PortalLoading from '../portal/(protected)/loading';

describe('Ladezustände der geschützten Bereiche', () => {
  it.each<[string, ComponentType]>([
    ['Kanzlei', StaffLoading],
    ['Portal', PortalLoading],
  ])('%s: meldet den Ladevorgang einmal als Status', (_area, Loading) => {
    const html = renderToStaticMarkup(<Loading />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/Seite wird geladen/g)).toHaveLength(1);
  });
});
