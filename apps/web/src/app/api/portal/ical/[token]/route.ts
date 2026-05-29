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
import { verifyIcalToken, buildIcs, type IcalEvent } from '@/server/ical/feed';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const contactId = verifyIcalToken(token);
  if (!contactId) {
    return new Response('Not Found', { status: 404 });
  }

  const contact = await prismaOwner.clientContact.findFirst({
    where: { id: contactId, active: true },
    select: { clientId: true, client: { select: { name: true } } },
  });
  if (!contact) {
    return new Response('Not Found', { status: 404 });
  }

  const lookback = new Date();
  lookback.setDate(lookback.getDate() - 90);

  const [deadlines, appointments] = await Promise.all([
    prismaOwner.taxDeadline.findMany({
      where: {
        clientId: contact.clientId,
        status: { notIn: ['DONE', 'SKIPPED'] },
        dueDate: { gte: lookback },
      },
      select: { id: true, kind: true, period: true, dueDate: true },
      orderBy: { dueDate: 'asc' },
      take: 500,
    }),
    prismaOwner.appointment.findMany({
      where: {
        clientId: contact.clientId,
        status: { not: 'CANCELLED' },
        startsAt: { gte: lookback },
      },
      select: { id: true, title: true, startsAt: true, endsAt: true, location: true },
      orderBy: { startsAt: 'asc' },
      take: 500,
    }),
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
