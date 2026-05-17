// =============================================================================
// GET /api/n8n/overdue-requests?tenantId=<uuid>
//
// Liefert offene/in-Bearbeitung-Requests eines Tenants, deren Fälligkeit
// überschritten ist. n8n MUSS `tenantId` als Query-Parameter mitschicken.
//
// Defense in Depth (Audit Round 14, Finding 1): Vor dem Audit lief dieser
// Endpoint cross-tenant — die Sicherheit hing allein am N8N_HMAC_SECRET.
// Bei HMAC-Leak oder kompromittiertem n8n wären beliebige Cross-Tenant-
// Reads möglich gewesen. Jetzt: `tenantId` ist Teil der Query und somit der
// signierten URL (verify.ts:56 inkludiert `nextUrl.search`) UND
// erzwungener DB-Filter.
//
// Response: { requests: [{ id, clientName, contactEmail?, contactName?,
//                          title, dueAt, daysOverdue, signerEmail }] }
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyN8nSignature } from '@/server/n8n/verify';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';

const TenantIdSchema = z.string().uuid();

export async function GET(req: NextRequest) {
  const ver = await verifyN8nSignature(req);
  if (!ver.ok) {
    // Audit 2: generische Antwort, Detail nur ins Log.
    log.warn({ component: 'n8n', reason: ver.error }, 'n8n-verify: rejected');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const tenantId = TenantIdSchema.safeParse(req.nextUrl.searchParams.get('tenantId'));
  if (!tenantId.success) {
    return NextResponse.json({ error: 'tenantId query parameter required' }, { status: 400 });
  }

  const now = new Date();
  const rows = await prismaOwner.request.findMany({
    where: {
      tenantId: tenantId.data,
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      dueAt: { not: null, lt: now },
    },
    include: {
      client: {
        include: {
          contacts: { where: { active: true }, take: 1, orderBy: { fullName: 'asc' } },
        },
      },
    },
  });

  const requests = rows
    .filter((r) => r.client.contacts.length > 0)
    .map((r) => {
      const c = r.client.contacts[0]!;
      const days = Math.floor((now.getTime() - (r.dueAt as Date).getTime()) / (24 * 60 * 60 * 1000));
      return {
        id: r.id,
        tenantId: r.tenantId,
        clientName: r.client.name,
        contactEmail: c.email,
        contactName: c.fullName,
        signerEmail: c.email,
        title: r.title,
        dueAt: r.dueAt,
        daysOverdue: days,
      };
    });

  return NextResponse.json({ count: requests.length, requests });
}
