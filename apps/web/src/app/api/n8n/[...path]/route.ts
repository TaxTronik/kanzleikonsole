// =============================================================================
// n8n-Webhook-Eingang — HMAC-signierte Calls von n8n
//
// n8n schickt alle App-Calls hierher. Jeder Request wird via HMAC-SHA256
// mit N8N_HMAC_SECRET verifiziert (inkl. Timestamp + Nonce-Replay-Schutz).
// Routet dann an den passenden Handler.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { verifyN8nSignature } from '@/server/n8n/verify';
import { log } from '@/server/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const ver = await verifyN8nSignature(request);
  if (!ver.ok) {
    // Audit Round 14, Finding 2: Generische Antwort, damit der Client nicht
    // zwischen „signature mismatch", „timestamp outside replay window" und
    // „replay detected" unterscheiden kann. Das wäre sonst ein Side-Channel
    // über Schlüssel-/Zeit-/Replay-Status. Detail nur ins Log für Ops.
    log.warn(
      { component: 'n8n-webhook', reason: ver.error, status: ver.status },
      'n8n-verify: rejected',
    );
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: ver.status === 503 ? 503 : 401 },
    );
  }

  const { path } = await params;
  const action = path.join('/');

  // N-10: verifyN8nSignature liest den Body bereits via `await req.text()` für
  // die HMAC-Verifikation. NextRequest-Bodies sind one-shot — ein zweites
  // `await request.json()` würde später leer/`undefined` zurückkommen.
  // ver.body enthält das bereits gelesene Roh-JSON; konkrete Handler in
  // Iteration 2 müssen es daraus parsen statt nochmal vom Request zu lesen.
  const rawBody = ver.body ?? '';
  let payload: unknown = null;
  if (rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }
  }

  // Iteration 2: konkrete Handler pro action implementieren
  // z. B. 'reminders/request-due', 'gwg/expiry-warning' etc.
  // Handler bekommen `payload` als zweites Argument — KEIN erneutes
  // request.json()/request.text() im Handler-Body!
  void payload;
  return NextResponse.json(
    { error: `Handler für '${action}' noch nicht implementiert.` },
    { status: 501 },
  );
}
