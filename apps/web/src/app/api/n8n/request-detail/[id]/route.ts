// =============================================================================
// GET /api/n8n/request-detail/[id]?tenantId=<uuid>
//
// Defense in Depth (Audit Round 14, Finding 1): tenantId muss in der Query
// stehen und stimmt mit dem geladenen Datensatz überein. Ohne tenantId:
// 400. Mit falschem tenantId für eine fremde Request-ID: 404 — wir
// preisgeben nicht, ob die ID existiert.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyN8nSignature, n8nRejectResponse } from '@/server/n8n/verify';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';

const TenantIdSchema = z.string().uuid();

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ver = await verifyN8nSignature(req);
  if (!ver.ok) {
    log.warn({ component: 'n8n', reason: ver.error }, 'n8n-verify: rejected');
    // Befund 10: zentrales Status-Mapping (503/500 retrybar, sonst 401).
    return n8nRejectResponse(ver);
  }
  const { id } = await params;

  const tenantId = TenantIdSchema.safeParse(req.nextUrl.searchParams.get('tenantId'));
  if (!tenantId.success) {
    return NextResponse.json({ error: 'tenantId query parameter required' }, { status: 400 });
  }

  const r = await prismaOwner.request.findFirst({
    where: { id, tenantId: tenantId.data },
    include: {
      client: {
        include: {
          contacts: { where: { active: true }, orderBy: { fullName: 'asc' } },
        },
      },
    },
  });
  if (!r) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const contact = r.client.contacts[0];
  // Empfänger, die Mails möchten — n8n-Workflows MÜSSEN diesen Filter
  // respektieren (siehe ClientContact.notificationsEnabled).
  const notifiableContacts = r.client.contacts
    .filter((c) => c.notificationsEnabled)
    .map((c) => ({ id: c.id, fullName: c.fullName, email: c.email }));

  return NextResponse.json({
    id: r.id,
    tenantId: r.tenantId,
    title: r.title,
    description: r.description,
    priority: r.priority,
    status: r.status,
    dueAt: r.dueAt,
    clientName: r.client.name,
    contactName: contact?.fullName ?? null,
    contactEmail: contact?.email ?? null,
    notifiableContacts,
  });
}
