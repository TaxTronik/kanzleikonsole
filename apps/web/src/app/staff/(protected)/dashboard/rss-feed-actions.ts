'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { seedDefaultRssFeeds } from '@/server/rss/defaults';
import { assertPublicHost } from '@/server/http/ssrf-guard';

export interface ActionResult { ok: boolean; error?: string; }

const UrlSchema = z
  .string()
  .url()
  .max(500)
  .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
    message: 'Nur http(s)-URLs erlaubt.',
  });

// R-7: Pro Mitarbeiter darf eine sinnvolle Obergrenze gelten — verhindert,
// dass ein einzelner Staff durch viele Feeds den Worker beschäftigt.
const MAX_FEEDS_PER_STAFF = 10;

const AddSchema = z.object({
  name: z.string().min(1).max(80),
  url: UrlSchema,
  color: z.string().max(20).optional().or(z.literal('')),
});

export async function addRssFeedAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = AddSchema.safeParse({
    name: formData.get('name'),
    url: formData.get('url'),
    color: formData.get('color') ?? '',
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const urlClean = parsed.data.url.trim();

  // R-1: SSRF-Guard schon beim Speichern. Vorher prüfte nur der Worker beim
  // Fetch — interne URLs (http://10.0.0.5:8080/feed) ließen sich als „aktiv"
  // ablegen und beim Fetch unterschieden die Fehlermeldungen zwischen
  // „SSRF-Block", „DNS failed", „Connection refused" → Insider-Enumerations-
  // vektor. assertPublicHost weist private/loopback/CGNAT/IPv6-Sondernutzung
  // ab (M-5).
  try {
    await assertPublicHost(urlClean);
  } catch (e) {
    return { ok: false, error: `URL nicht zulässig: ${(e as Error).message}` };
  }

  // R-7: Nur ADMIN/PARTNER darf Feeds für den Tenant anlegen; reguläre Staff
  // können bestehende Feeds nutzen, aber keine neuen Worker-Fetches einreihen.
  // Plus pro-Staff-Limit als zusätzliche Bremse, falls die Rolle künftig
  // gelockert wird.
  const adminOnly = !isStaffAdmin(session);

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        if (adminOnly) {
          throw new Error('Nur ADMIN/PARTNER darf neue RSS-Feeds anlegen.');
        }
        const count = await tx.rssFeed.count({ where: { tenantId, staffId } });
        if (count >= MAX_FEEDS_PER_STAFF) {
          throw new Error(`Limit von ${MAX_FEEDS_PER_STAFF} Feeds pro Mitarbeiter erreicht.`);
        }
        const f = await tx.rssFeed.create({
          data: {
            tenantId,
            staffId,
            name: parsed.data.name.trim(),
            url: urlClean,
            color: parsed.data.color || null,
            // R-7: Neue Feeds starten inaktiv — Admin schaltet bewusst an.
            // Verhindert, dass ein Klick versehentlich/böswillig den Worker
            // sofort gegen eine neue URL drauf wirft.
            active: false,
          },
        });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'rss_feed.add',
          resourceType: 'rss_feed',
          resourceId: f.id,
          after: { name: parsed.data.name, url: urlClean, active: false },
        });
      },
    );
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return { ok: false, error: 'Dieser Feed ist schon abonniert.' };
    }
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/dashboard');
  return { ok: true };
}

export async function toggleRssFeedAction(input: { id: string; active: boolean }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z.object({ id: z.string().uuid(), active: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        await tx.rssFeed.update({
          where: { id: parsed.data.id },
          data: { active: parsed.data.active },
        });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: parsed.data.active ? 'rss_feed.enable' : 'rss_feed.disable',
          resourceType: 'rss_feed',
          resourceId: parsed.data.id,
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/dashboard');
  return { ok: true };
}

export async function deleteRssFeedAction(input: { id: string }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const f = await tx.rssFeed.findUnique({
          where: { id: parsed.data.id },
          select: { name: true, url: true },
        });
        await tx.rssFeed.delete({ where: { id: parsed.data.id } });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'rss_feed.delete',
          resourceType: 'rss_feed',
          resourceId: parsed.data.id,
          before: { name: f?.name ?? null, url: f?.url ?? null },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/dashboard');
  return { ok: true };
}

export async function resetRssFeedDefaultsAction(): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        await seedDefaultRssFeeds(tx, tenantId, staffId);
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'rss_feed.reset_defaults',
          resourceType: 'staff_user',
          resourceId: staffId,
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/dashboard');
  return { ok: true };
}
