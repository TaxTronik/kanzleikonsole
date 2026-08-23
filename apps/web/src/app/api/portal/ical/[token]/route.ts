// =============================================================================
// GET /api/portal/ical/[token]
//
// Read-only ICS-Kalender-Feed für einen Mandanten-Kontakt. Token-gated
// (HMAC, siehe server/ical/feed.ts) — KEINE Session, damit Kalender-Apps
// abonnieren können. Liefert Steuertermine (Fristen) + Termine des Mandanten.
// =============================================================================

import { type NextRequest } from 'next/server';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { prismaOwner } from '@/server/db/prisma-owner';
import { readBooleanTenantModules } from '@taxtronik/db/tenant-modules';
import { verifyIcalToken, buildIcs, type IcalEvent } from '@/server/ical/feed';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const verified = verifyIcalToken(token);
  if (!verified) {
    return new Response('Not Found', { status: 404 });
  }

  const contact = await prismaOwner.clientContact.findFirst({
    where: { id: verified.contactId, active: true },
    select: {
      tenantId: true,
      clientId: true,
      icalTokenVersion: true,
      client: { select: { name: true, allowActive: true, anonymizedAt: true } },
    },
  });
  // Versions-Check (Audit 2026-06 Befund 3): Token trägt die Version, mit der
  // er signiert wurde — stimmt sie nicht mehr mit dem DB-Stand überein, wurde
  // der Feed für diesen Kontakt widerrufen. Gleiche 404 wie bei ungültigem
  // Token (kein Orakel, ob ein Kontakt existiert).
  if (
    !contact ||
    contact.icalTokenVersion !== verified.version ||
    !contact.client.allowActive ||
    contact.client.anonymizedAt !== null
  ) {
    return new Response('Not Found', { status: 404 });
  }

  const modules = await readBooleanTenantModules(prismaOwner, contact.tenantId);
  if (!modules.taxNotices && !modules.appointments) {
    return new Response('Not Found', { status: 404 });
  }

  const lookback = new Date();
  lookback.setDate(lookback.getDate() - 90);

  const [deadlines, appointments] = await Promise.all([
    modules.taxNotices
      ? prismaOwner.taxDeadline.findMany({
          where: {
            clientId: contact.clientId,
            status: { notIn: ['DONE', 'SKIPPED'] },
            dueDate: { gte: lookback },
          },
          select: { id: true, kind: true, period: true, dueDate: true },
          orderBy: { dueDate: 'asc' },
          take: 500,
        })
      : Promise.resolve([]),
    modules.appointments
      ? prismaOwner.appointment.findMany({
          where: {
            clientId: contact.clientId,
            status: { not: 'CANCELLED' },
            startsAt: { gte: lookback },
          },
          select: { id: true, title: true, startsAt: true, endsAt: true, location: true },
          orderBy: { startsAt: 'asc' },
          take: 500,
        })
      : Promise.resolve([]),
  ]);

  const events: IcalEvent[] = [];
  for (const d of deadlines) {
    events.push({
      uid: `dl-${d.id}`,
      start: d.dueDate,
      allDay: true,
      summary: `Frist: ${SCHEDULE_LABELS[d.kind] ?? d.kind} (${d.period})`,
      description: 'Steuertermin Ihrer Kanzlei.',
    });
  }
  for (const a of appointments) {
    events.push({
      uid: `appt-${a.id}`,
      start: a.startsAt,
      end: a.endsAt,
      allDay: false,
      summary: a.title,
      description: a.location ? `Ort: ${a.location}` : null,
    });
  }

  const ics = buildIcs(`${contact.client.name} — Termine & Fristen`, events);

  return new Response(ics, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="taxtronik-fristen.ics"',
      // Kalender-Apps pollen periodisch; kurzes Caching reicht.
      'cache-control': 'private, max-age=3600',
    },
  });
}
