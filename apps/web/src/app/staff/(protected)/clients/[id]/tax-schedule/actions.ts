'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import type { Prisma, TaxScheduleKind } from '@prisma/client';
import { evidenceService } from '@/server/container';
import { materializeTaxDeadlines } from '@/server/tax-deadlines/materialize';
import { notifyRequestOpened } from '@/server/mail/dispatch';
import { fireAndForget } from '@/server/util/fire-and-forget';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { staffActionGuard } from '@/server/actions/staff-action';
import { berlinTodayUtcMidnight } from '@taxtronik/tax';

const ALL_KINDS: TaxScheduleKind[] = [
  'USTA_MONATLICH',
  'USTA_QUARTAL',
  'USTA_JAEHRLICH',
  'LSTA_MONATLICH',
  'LSTA_QUARTAL',
  'LSTA_JAEHRLICH',
  'EST_VZ',
  'KST_VZ',
  'GEWST_VZ',
  'EST_ERKLAERUNG',
  'KST_ERKLAERUNG',
  'GEWST_ERKLAERUNG',
];

// Beratene Erklärungsfrist § 149 (3) AO — nur für Erklärungen zulässig
// (nicht Anmeldungen, nicht Vorauszahlungen). Serverseitige Whitelist,
// damit ein manipuliertes Formular advised nicht auf andere Arten setzt.
const ADVISED_KINDS = new Set<TaxScheduleKind>([
  'USTA_JAEHRLICH',
  'EST_ERKLAERUNG',
  'KST_ERKLAERUNG',
  'GEWST_ERKLAERUNG',
]);

// Analog für Dauerfrist (§§ 46-48 UStDV: nur USt-Voranmeldungen).
const DAUERFRIST_KINDS = new Set<TaxScheduleKind>(['USTA_MONATLICH', 'USTA_QUARTAL']);

export interface ActionResult {
  ok: boolean;
  error?: string;
  savedAt?: string;
}

export async function saveScheduleConfigAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ module: 'taxNotices' });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = z.string().uuid().safeParse(formData.get('clientId'));
  if (!parsed.success) return { ok: false, error: 'Ungültige Mandanten-ID.' };
  const clientId = parsed.data;

  // Pro Kind die Felder einsammeln. Dauerfrist/advised werden serverseitig
  // auf die fachlich zulässigen Arten begrenzt (Whitelists oben).
  // reminder/lead: bei abgeschalteter Auto-Anforderung sind die Zahlenfelder
  // im Formular disabled (nicht submitted) — dann bleiben unten die
  // gespeicherten Werte erhalten statt auf die Defaults zurückzufallen.
  const updates = ALL_KINDS.map((kind) => ({
    kind,
    active: formData.get(`active.${kind}`) === 'on',
    hasDauerfrist: DAUERFRIST_KINDS.has(kind) && formData.get(`dauerfrist.${kind}`) === 'on',
    advised: ADVISED_KINDS.has(kind) && formData.get(`advised.${kind}`) === 'on',
    autoRequest: formData.get(`autoRequest.${kind}`) === 'on',
    reminderDaysBefore: clampInt(formData.get(`reminder.${kind}`), 1, 90, 10),
    staffLeadDays: clampInt(formData.get(`lead.${kind}`), 0, 30, 3),
  }));

  await withTenantContext(ctx, async (tx) => {
    await assertClientAccessTx(tx, session, clientId);
    // R-2: clientId Tenant-Sanity vor allen taxScheduleConfig-Mutationen.
    await assertClientInTenant(tx, clientId);
    const now = new Date();
    // Bestehende laden für Diff
    const existing = await tx.taxScheduleConfig.findMany({ where: { clientId } });
    const byKind = new Map(existing.map((c) => [c.kind, c]));

    for (const u of updates) {
      const old = byKind.get(u.kind);

      if (!u.active) {
        // Inaktiv: Wenn Eintrag existiert → auf active=false setzen UND
        // alle noch nicht erledigten Termine wegputzen, damit der Kalender
        // sauber ist. Erledigte Termine bleiben (Audit-relevant).
        if (old && old.active) {
          const removedCount = await removeReschedulableDeadlines(
            tx,
            tenantId,
            clientId,
            u.kind,
            now,
          );
          await tx.taxScheduleConfig.update({
            where: { id: old.id },
            data: { active: false },
          });
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'tax_schedule.deactivate',
            resourceType: 'tax_schedule_config',
            resourceId: old.id,
            before: { active: true },
            after: { active: false, removedDeadlines: removedCount },
          });
        }
        continue;
      }

      // Aktiv: Upsert
      if (old) {
        // Fristrelevante Änderung (Dauerfrist/advised)? Dann müssen die noch
        // offenen Termine dieses Kinds WEG, bevor neu materialisiert wird:
        // materialize nutzt createMany(skipDuplicates) über (tenant, client,
        // kind, period) — ein bestehender Termin derselben Periode bliebe
        // sonst mit dem ALTEN Fälligkeitsdatum stehen und das neue würde nie
        // geschrieben. Erledigte Termine bleiben (Audit-relevant), analog
        // zum Deactivate-Pfad oben.
        const datesChanged = old.hasDauerfrist !== u.hasDauerfrist || old.advised !== u.advised;
        let removedCount = 0;
        if (old.active && datesChanged) {
          // Fristverschiebende Änderung → auch laufende (IN_PROGRESS) Zukunfts-
          // termine neu datieren, damit keiner mit veraltetem Fälligkeitsdatum
          // stehen bleibt. Sie kommen korrekt neu materialisiert zurück.
          removedCount = await removeReschedulableDeadlines(
            tx,
            tenantId,
            clientId,
            u.kind,
            now,
            true,
          );
        }
        // Bei abgeschalteter Auto-Anforderung sind die Tage-Felder im Formular
        // disabled (nicht submitted) — gespeicherte Werte NICHT überschreiben,
        // damit ein Wiedereinschalten die alte Konfiguration vorfindet.
        const reminderDaysBefore = u.autoRequest ? u.reminderDaysBefore : old.reminderDaysBefore;
        const staffLeadDays = u.autoRequest ? u.staffLeadDays : old.staffLeadDays;
        const pipelineChanged =
          old.autoRequest !== u.autoRequest ||
          old.reminderDaysBefore !== reminderDaysBefore ||
          old.staffLeadDays !== staffLeadDays;
        await tx.taxScheduleConfig.update({
          where: { id: old.id },
          data: {
            active: true,
            hasDauerfrist: u.hasDauerfrist,
            advised: u.advised,
            autoRequest: u.autoRequest,
            reminderDaysBefore,
            staffLeadDays,
          },
        });
        if (datesChanged || pipelineChanged) {
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'tax_schedule.update',
            resourceType: 'tax_schedule_config',
            resourceId: old.id,
            before: {
              hasDauerfrist: old.hasDauerfrist,
              advised: old.advised,
              autoRequest: old.autoRequest,
              reminderDaysBefore: old.reminderDaysBefore,
              staffLeadDays: old.staffLeadDays,
            },
            after: {
              hasDauerfrist: u.hasDauerfrist,
              advised: u.advised,
              autoRequest: u.autoRequest,
              reminderDaysBefore,
              staffLeadDays,
              rematerializedDeadlines: removedCount,
            },
          });
        }
      } else {
        const created = await tx.taxScheduleConfig.create({
          data: {
            tenantId,
            clientId,
            kind: u.kind,
            active: true,
            hasDauerfrist: u.hasDauerfrist,
            advised: u.advised,
            autoRequest: u.autoRequest,
            reminderDaysBefore: u.reminderDaysBefore,
            staffLeadDays: u.staffLeadDays,
            createdByStaff: staffId,
          },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'tax_schedule.create',
          resourceType: 'tax_schedule_config',
          resourceId: created.id,
          after: {
            kind: u.kind,
            hasDauerfrist: u.hasDauerfrist,
            advised: u.advised,
            autoRequest: u.autoRequest,
            reminderDaysBefore: u.reminderDaysBefore,
            staffLeadDays: u.staffLeadDays,
          },
        });
      }
    }
  });

  // Direkt materialisieren, damit die neuen aktiven Termine sofort sichtbar sind
  const stats = await materializeTaxDeadlines(ctx, { systemStaffId: staffId });

  // Mandanten-Mail + n8n-Event NACH dem Commit (gleiche Semantik wie
  // createRequestCore). Trifft hier nur Configs mit staffLeadDays = 0, deren
  // Versandfenster bereits offen ist — sonst kommt der Versand vom Tageslauf.
  if (stats.createdRequests.length > 0) {
    fireAndForget(
      'notifyRequestOpened (tax-schedule save)',
      Promise.all(
        stats.createdRequests.map((r) =>
          notifyRequestOpened({
            tenantId: r.tenantId,
            clientId: r.clientId,
            requestId: r.requestId,
            title: r.title,
            description: r.description,
            priority: r.priority,
            dueAtIso: r.dueDate.toISOString(),
          }),
        ),
      ).then(() => undefined),
    );
  }

  revalidatePath(`/staff/clients/${clientId}/tax-schedule`);
  revalidatePath('/staff/tax-deadlines');
  return { ok: true, savedAt: new Date().toISOString() };
}

// #10 (Fristen-Schutz): nur NICHT fällige, noch nicht versäumte Termine
// entfernen — die materialisiert der Lauf am Ende ohnehin neu (mit ggf.
// verschobenem Fälligkeitsdatum). Bewusst NIE gelöscht: OVERDUE (bereits
// VERSÄUMTE Frist — dieses Signal darf nie spurlos verschwinden) und bereits
// fällige Termine.
//
// IN_PROGRESS wird NUR bei einer fristverschiebenden Umparametrisierung entfernt
// (includeInProgress=true): dort ist die alte Fälligkeit falsch, und der Termin
// kommt korrekt neu materialisiert (als PLANNED am neuen Datum) zurück — besser
// als ein aktiver Termin mit veraltetem Datum. Bei einer DEAKTIVIERUNG bleibt
// IN_PROGRESS dagegen als aktives Bearbeitungssignal erhalten (die Pflicht endet,
// aber die laufende Bearbeitung soll nicht verschwinden).
//
// Verknüpfte Mandantenanforderungen der entfernten Termine werden geschlossen
// (kein Verwaisen, keine Dublette bei der Neu-Materialisierung). Grenze
// dueDate ≥ UTC-Kodierung des heutigen BERLIN-Kalendertags deckt sich mit dem
// Re-Materialize-Tor in materialize.ts, das vergangene Termine nie neu erzeugt.
async function removeReschedulableDeadlines(
  tx: Prisma.TransactionClient,
  tenantId: string,
  clientId: string,
  kind: TaxScheduleKind,
  now: Date,
  includeInProgress = false,
): Promise<number> {
  const startOfToday = berlinTodayUtcMidnight(now);
  const toRemove = await tx.taxDeadline.findMany({
    where: {
      clientId,
      kind,
      status: {
        in: includeInProgress ? ['PLANNED', 'REMINDED', 'IN_PROGRESS'] : ['PLANNED', 'REMINDED'],
      },
      dueDate: { gte: startOfToday },
    },
    select: { id: true, requestId: true },
  });
  if (toRemove.length === 0) return 0;
  const requestIds = toRemove.map((d) => d.requestId).filter((r): r is string => r !== null);
  if (requestIds.length > 0) {
    await tx.request.updateMany({
      where: { id: { in: requestIds }, status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] } },
      data: { status: 'CANCELLED' },
    });
  }
  await resolveNotificationsTx(tx, {
    tenantId,
    resources: [
      ...toRemove.map((deadline) => ({
        resourceType: 'tax_deadline',
        resourceId: deadline.id,
      })),
      ...requestIds.map((requestId) => ({ resourceType: 'request', resourceId: requestId })),
    ],
  });
  await tx.taxDeadline.deleteMany({ where: { id: { in: toRemove.map((d) => d.id) } } });
  return toRemove.length;
}

function clampInt(
  v: FormDataEntryValue | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
