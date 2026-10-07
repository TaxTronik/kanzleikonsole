// =============================================================================
// GET /api/portal/ical/[token]
//
// Read-only ICS-Kalender-Feed für einen Mandanten-Kontakt. Token-gated
// (HMAC, siehe server/ical/feed.ts) — KEINE Session, damit Kalender-Apps
// abonnieren können. Liefert Steuertermine (Fristen) + Termine des Mandanten.
//
// S-01: Vor dem Tenant-Kontext kennt die Route nur die Kontakt-ID aus dem
// Token. Der Owner-Client löst daraus allein den Tenant auf; Kontakt, Mandant,
// Modulschalter, Fristen und Termine liest die App-Rolle im SYSTEM-Kontext
// dieses Tenants (withSystemContext, RLS).
// =============================================================================

import { type NextRequest } from 'next/server';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { withSystemContext } from '@taxtronik/db';
import { prismaOwner } from '@/server/db/prisma-owner';
import { readBooleanTenantModules } from '@taxtronik/db/tenant-modules';
import { verifyIcalToken, buildIcs, type IcalEvent } from '@/server/ical/feed';

const notFound = () => new Response('Not Found', { status: 404 });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const verified = verifyIcalToken(token);
  if (!verified) {
    return notFound();
  }

  // S-01: Die mandantenübergreifende Auflösung Token → Tenant (nur die ID) liest der Owner-Client.
  const resolved = await prismaOwner.clientContact.findFirst({
    where: { id: verified.contactId, active: true },
    select: { tenantId: true },
  });
  if (!resolved) {
    return notFound();
  }
  const tenantId = resolved.tenantId;

  const feed = await withSystemContext(tenantId, async (tx) => {
    const contact = await tx.clientContact.findFirst({
      where: { id: verified.contactId, tenantId, active: true },
      select: {
        clientId: true,
        icalTokenVersion: true,
        client: {
          select: { name: true, allowActive: true, anonymizedAt: true, mandateEndedAt: true },
        },
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
      contact.client.anonymizedAt !== null ||
      contact.client.mandateEndedAt != null
    ) {
      return null;
    }

    const modules = await readBooleanTenantModules(tx, tenantId);
    if (!modules.taxNotices && !modules.appointments) {
      return null;
    }

    const lookback = new Date();
    lookback.setDate(lookback.getDate() - 90);

    const deadlines = modules.taxNotices
      ? await tx.taxDeadline.findMany({
          where: {
            tenantId,
            clientId: contact.clientId,
            status: { notIn: ['DONE', 'SKIPPED'] },
            dueDate: { gte: lookback },
          },
          select: { id: true, kind: true, period: true, dueDate: true },
          orderBy: { dueDate: 'asc' },
          take: 500,
        })
      : [];
    const appointments = modules.appointments
      ? await tx.appointment.findMany({
          where: {
            tenantId,
            clientId: contact.clientId,
            status: { not: 'CANCELLED' },
            startsAt: { gte: lookback },
          },
          select: { id: true, title: true, startsAt: true, endsAt: true, location: true },
          orderBy: { startsAt: 'asc' },
          take: 500,
        })
      : [];
    return { clientName: contact.client.name, deadlines, appointments };
  });
  if (!feed) {
    return notFound();
  }
  const { deadlines, appointments } = feed;

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

  const ics = buildIcs(`${feed.clientName} — Termine & Fristen`, events);

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
