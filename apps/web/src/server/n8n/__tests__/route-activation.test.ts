import { describe, expect, it } from 'vitest';
import { connectionPatchForSavedRoute } from '../route-activation';

describe('n8n route activation', () => {
  it('aktiviert eine provisionierte Connection zusammen mit der verifizierten Route', () => {
    expect(
      connectionPatchForSavedRoute({
        connection: { enabled: false, routingMode: 'DISABLED' },
        routeEnabledRequested: true,
        activationBlocked: false,
      }),
    ).toEqual({ enabled: true, routingMode: 'EXPLICIT' });
  });

  it('reaktiviert die Connection nicht für einen ungetesteten Routenentwurf', () => {
    expect(
      connectionPatchForSavedRoute({
        connection: { enabled: false, routingMode: 'DISABLED' },
        routeEnabledRequested: true,
        activationBlocked: true,
      }),
    ).toEqual({});
  });

  it('wechselt eine bereits aktive Legacy-Verbindung beim Mapping auf explizites Routing', () => {
    expect(
      connectionPatchForSavedRoute({
        connection: { enabled: true, routingMode: 'LEGACY' },
        routeEnabledRequested: false,
        activationBlocked: false,
      }),
    ).toEqual({ routingMode: 'EXPLICIT' });
  });
});
