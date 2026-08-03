// =============================================================================
// GET /api/staff/clients/[id]/reminders
//
// Leichtgewichtiger Nachlade-Endpunkt fuer den Wiedervorlagen-Block auf der
// Mandantenseite. Diese Seite ist vom Bell-getriebenen Voll-Refresh bewusst
// ausgenommen (sie laedt viele Bloecke und bis zu 1.000 Dokumente) — eine frisch
// delegierte Wiedervorlage erschien deshalb erst nach manuellem Reload. Statt
// die teure Ausnahme aufzuweichen, holt sich der Block genau SEINE Daten nach.
//
// Liefert dieselbe Form, die die Seite serverseitig rendert.
// =============================================================================

import { NextResponse } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { requireClientAccess, ForbiddenError, UnauthorizedError } from '@/server/auth/rbac';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ROWS = 50;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Gleiches Muster wie die Subsumtions-Export-Route: staffAuth fuer den
  // 401-Fall, requireClientAccess fuer die Mandantentrennung (403).
  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    await requireClientAccess(id);
  } catch (e) {
    if (e instanceof ForbiddenError)
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    if (e instanceof UnauthorizedError)
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    throw e;
  }

  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };

  const modules = await readModules(ctx);
  if (!modules.reminders) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const items = await withTenantContext(ctx, async (tx) => {
    const rows = await tx.clientReminder.findMany({
      where: { clientId: id },
      orderBy: [{ doneAt: 'asc' }, { dueDate: 'asc' }],
      take: MAX_ROWS,
      select: {
        id: true,
        dueDate: true,
        subject: true,
        notes: true,
        priority: true,
        doneAt: true,
        createdByStaff: true,
        assigneeStaffId: true,
        riskMarkings: { select: { id: true, analysisId: true }, take: 1 },
      },
    });

    const staffIds = [
      ...new Set(rows.flatMap((r) => [r.createdByStaff, r.assigneeStaffId].filter(Boolean))),
    ] as string[];
    const namen = new Map(
      (
        await tx.staffUser.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, fullName: true },
        })
      ).map((s) => [s.id, s.fullName]),
    );

    return rows.map((r) => ({
      id: r.id,
      dueDate: r.dueDate.toISOString(),
      subject: r.subject,
      notes: r.notes,
      priority: r.priority,
      doneAt: r.doneAt ? r.doneAt.toISOString() : null,
      assigneeName: r.assigneeStaffId ? (namen.get(r.assigneeStaffId) ?? null) : null,
      researchMarkingId: r.riskMarkings[0]?.id ?? null,
      researchAnalysisId: r.riskMarkings[0]?.analysisId ?? null,
      createdByStaff: r.createdByStaff,
      createdByName: namen.get(r.createdByStaff) ?? null,
      assigneeStaffId: r.assigneeStaffId,
    }));
  });

  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
}
