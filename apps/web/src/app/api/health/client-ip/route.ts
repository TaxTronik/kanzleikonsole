// =============================================================================
// GET /api/health/client-ip
//
// B3: Diagnose für den Deploy-/Update-Smoke der Operator-CLI (smoke_client_ip
// in scripts/ops/deploy.sh). Mit TRUST_PROXY_REQUIRED=true ruft der Smoke diese
// Route über den öffentlichen Pfad (NEXTAUTH_URL, also durch den Reverse-Proxy)
// auf und prüft, dass die App eine echte Client-IP ermittelt statt keiner oder
// der Adresse des Proxys bzw. Docker-Netzes.
//
// Wie /api/health öffentlich und ohne Session: Die Antwort enthält nur die
// Adresse, die die App für genau diesen Aufrufer ermittelt hat, ermittelt mit
// derselben Funktion wie Rate-Limits, Kontosperren und Audit-IPs
// (getClientIp, server/rate-limit). Keine Header, Hostnamen oder
// Proxy-Konfiguration; ohne Proxy-Zusage (TRUST_PROXY_REQUIRED=false) in
// Produktion immer `null`.
// =============================================================================

import { NextResponse } from 'next/server';
import { getClientIp } from '@/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return NextResponse.json(
    { clientIp: getClientIp(request.headers) },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
