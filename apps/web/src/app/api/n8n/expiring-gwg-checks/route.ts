// =============================================================================
// GET /api/n8n/expiring-gwg-checks?withinDays=30[&tenantId=<uuid>]
//
// BEWUSST CROSS-TENANT bei fehlendem `tenantId`-Parameter — der typische
// taxtronik-Deploy ist single-tenant on-prem und der GwG-Beauftragte einer
// Kanzlei bekommt eine konsolidierte Tages-Mail über alle Mandanten (siehe
// infra/n8n/workflows/02-gwg-expiry-check.json — der dortige Workflow ruft
// uns ohne tenantId auf und mailt das aggregierte Resultat an
// `GWG_OFFICER_EMAIL`).
//
// Mehrtenant-Deploys MÜSSEN `tenantId` mitschicken (dann liefert der
// Endpoint nur Treffer dieses Tenants, RLS-symmetrisch zu den anderen
// /api/n8n/*-Routen — Audit Round 14, Finding 1).
//
// Hinweis für künftige Iterationen: NICHT blind das Pattern aus
// overdue-requests/route.ts oder request-detail/[id]/route.ts hierher
// kopieren, sonst würde der bestehende Single-Tenant-Workflow brechen.
// Wenn ein neuer Endpoint cross-tenant zulassen will, muss er das hier
// genauso explizit dokumentieren.
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
    // Audit Round 15, Finding 2: generische Antwort, Detail nur ins Log.
    log.warn({ component: 'n8n', reason: ver.error }, 'n8n-verify: rejected');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const withinDays = Number(req.nextUrl.searchParams.get('withinDays') ?? '30');
  if (!Number.isFinite(withinDays) || withinDays < 1 || withinDays > 365) {
    return NextResponse.json({ error: 'invalid withinDays' }, { status: 400 });
  }

  // Optionaler Tenant-Filter: wenn der Parameter gesetzt ist, MUSS er
  // valide sein — leerer/kaputter Wert ist ein Konfigurationsfehler im
  // n8n-Workflow und soll laut werden.
  const rawTenantId = req.nextUrl.searchParams.get('tenantId');
  let tenantFilter: string | undefined;
  if (rawTenantId !== null) {
    const parsed = TenantIdSchema.safeParse(rawTenantId);
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid tenantId' }, { status: 400 });
    }
    tenantFilter = parsed.data;
  }

  const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);

  const checks = await prismaOwner.gwgCheck.findMany({
    where: {
      ...(tenantFilter ? { tenantId: tenantFilter } : {}),
      status: 'VERIFIED',
      validUntil: { not: null, lte: cutoff },
    },
    include: { client: { select: { name: true } } },
    orderBy: { validUntil: 'asc' },
  });

  return NextResponse.json({
    count: checks.length,
    checks: checks.map((c) => ({
      id: c.id,
      tenantId: c.tenantId,
      clientId: c.clientId,
      clientName: c.client.name,
      validUntil: c.validUntil,
      riskLevel: c.riskLevel,
    })),
  });
}
