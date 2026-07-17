import { NextResponse, type NextRequest } from 'next/server';
import { authenticateN8nCallback } from '@/server/n8n/callback-auth';

export const dynamic = 'force-dynamic';

// =============================================================================
// Ping-/Übersichts-Endpunkt für die Callback-Basis-URL.
//
// Das ACP zeigt "http://app:3000/api/integrations/n8n/v1" als Basis an —
// Operatoren testen naturgemäß genau diese URL und bekamen bisher eine
// Next-404-Seite ("wirkt kaputt"). Die Basis antwortet jetzt:
//   - ohne/mit ungültigem Credential: 401 + Hinweis, wie authentifiziert wird
//     und welche Endpunkte existieren (Pfade sind öffentlich dokumentiert,
//     keine Geheimnisse);
//   - mit gültigem Credential: 200 + gewährte Scopes — als Verbindungstest
//     aus n8n heraus nutzbar (keine x-taxtronik-request-id nötig).
// =============================================================================

const ENDPOINTS = [
  { path: 'overdue-requests', method: 'GET', scope: 'requests:read' },
  { path: 'request-detail/{id}', method: 'GET', scope: 'requests:read' },
  { path: 'expiring-gwg-checks', method: 'GET', scope: 'gwg:read' },
  { path: 'research-result', method: 'POST', scope: 'research:write' },
  { path: 'request-inbound', method: 'POST', scope: 'inbound-mail:write' },
] as const;

const AUTH_HINT =
  'Header: "Authorization: Bearer <Callback-Token>" + "x-taxtronik-key-id: <Key-ID>" (beides aus ACP Abschnitt 2 "Rückkanal n8n → TaxTronik"); Fach-Endpunkte zusätzlich "x-taxtronik-request-id: <eindeutige ID>".';

export async function GET(request: NextRequest) {
  const auth = await authenticateN8nCallback(request, null);
  if (!auth.ok) {
    return NextResponse.json(
      {
        service: 'taxtronik-n8n-callback',
        version: 'v1',
        error: auth.error,
        hint: AUTH_HINT,
        endpoints: ENDPOINTS,
      },
      { status: auth.status, headers: { 'cache-control': 'no-store' } },
    );
  }
  return NextResponse.json(
    {
      service: 'taxtronik-n8n-callback',
      version: 'v1',
      ok: true,
      authenticated: true,
      scopes: auth.scopes,
      endpoints: ENDPOINTS,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
