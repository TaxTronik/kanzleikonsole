// =============================================================================
// POST /api/n8n/request-inbound
//
// Inbound-Mail-Strecke (togglebares Modul `inboundMail`): n8n empfängt die
// E-Mail-Antwort eines Mandanten auf eine Anforderung, extrahiert requestId +
// Absender + Text und ruft diesen Endpoint. Wir legen eine RequestResponse an,
// setzen die Anforderung auf RESPONDED und benachrichtigen den zuständigen
// Mitarbeiter — wie die Portal-Antwort, nur eben per Mail eingetroffen.
//
// HMAC-gated (verify.ts signiert auch den Body). Defense in Depth: tenantId
// MUSS mitgeschickt werden und wird als DB-Filter erzwungen; der Absender muss
// ein bekannter aktiver Kontakt des Mandanten sein (sonst 422). Anhänge laufen
// NICHT über diesen Endpoint (kein Virus-Scan/Storage hier) — Text-Antwort
// genügt; Dokumente weiterhin über den Portal-Upload.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyN8nSignature, n8nRejectResponse } from '@/server/n8n/verify';
import { withSystemContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { log } from '@/server/logger';

const InboundSchema = z.object({
  tenantId: z.string().uuid(),
  requestId: z.string().uuid(),
  fromEmail: z.string().email().max(320),
  message: z.string().min(1).max(5000),
});

export async function POST(req: NextRequest) {
  const ver = await verifyN8nSignature(req);
  if (!ver.ok) {
    log.warn({ component: 'n8n', reason: ver.error }, 'n8n-verify: rejected');
    // Befund 10: zentrales Status-Mapping (503/500 retrybar, sonst 401).
    return n8nRejectResponse(ver);
  }

  let body: unknown;
  try {
    body = JSON.parse(ver.body ?? '{}');
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = InboundSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error' }, { status: 400 });
  }
  const { tenantId, requestId, fromEmail, message } = parsed.data;

  // Modul-Schalter: nur wenn die Kanzlei Inbound-Mail aktiviert hat.
  const modules = await readModules({ tenantId, actorId: null, actorType: 'SYSTEM' });
  if (!modules.inboundMail) {
    return NextResponse.json({ error: 'inbound_mail_disabled' }, { status: 403 });
  }

  const result = await withSystemContext(tenantId, async (tx) => {
    const request = await tx.request.findFirst({
      where: { id: requestId, tenantId, status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] } },
      select: { id: true, title: true, clientId: true, createdByStaff: true },
    });
    if (!request) return { status: 404 as const, error: 'request_not_found_or_closed' };

    // Absender muss ein bekannter aktiver Kontakt DIESES Mandanten sein.
    const contact = await tx.clientContact.findFirst({
      where: { clientId: request.clientId, email: fromEmail.toLowerCase(), active: true },
      select: { id: true },
    });
    if (!contact) return { status: 422 as const, error: 'unknown_sender' };

    await tx.requestResponse.create({
      data: { requestId, authorType: 'CLIENT_CONTACT', authorId: contact.id, message },
    });
    await tx.request.update({ where: { id: requestId }, data: { status: 'RESPONDED' } });

    await notify(tx, {
      tenantId,
      staffId: request.createdByStaff,
      kind: 'REQUEST_RESPONDED',
      title: `${request.title} — Antwort per E-Mail`,
      body: message.slice(0, 200) + (message.length > 200 ? '…' : ''),
      href: `/staff/requests/${requestId}`,
      resourceType: 'request',
      resourceId: requestId,
    });

    await evidenceService.record(tx, {
      tenantId,
      actorType: 'CLIENT_CONTACT',
      actorId: contact.id,
      action: 'request.response.inbound_mail',
      resourceType: 'request',
      resourceId: requestId,
      after: { via: 'inbound_mail', fromEmail: fromEmail.toLowerCase() },
    });

    return { status: 200 as const };
  });

  if (result.status !== 200) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
