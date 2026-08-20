import { describe, expect, it } from 'vitest';
import { connectionPatchForSavedRoute } from '../route-activation';

describe('n8n route activation', () => {
  it('aktiviert eine provisionierte Connection zusammen mit der bewusst aktiv gespeicherten Route', () => {
    expect(
      connectionPatchForSavedRoute({
        connection: { enabled: false, routingMode: 'DISABLED' },
        routeEnabledRequested: true,
      }),
    ).toEqual({ enabled: true, routingMode: 'EXPLICIT' });
  });

  it('reaktiviert die Connection nicht für eine deaktiviert gespeicherte Route', () => {
    expect(
      connectionPatchForSavedRoute({
        connection: { enabled: false, routingMode: 'DISABLED' },
        routeEnabledRequested: false,
      }),
    ).toEqual({});
  });

  it('wechselt eine bereits aktive Legacy-Verbindung beim Mapping auf explizites Routing', () => {
    expect(
      connectionPatchForSavedRoute({
        connection: { enabled: true, routingMode: 'LEGACY' },
        routeEnabledRequested: false,
      }),
    ).toEqual({ routingMode: 'EXPLICIT' });
  });
});
