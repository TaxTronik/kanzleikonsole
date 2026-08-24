'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { evidenceService } from '@/server/container';
import { enqueueTaxDeadlineMaterialize } from '@/server/jobs/tax-deadline-materialize-queue';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { staffActionGuard, withStaffModule, ActionError } from '@/server/actions/staff-action';

const withTaxNoticesStaff = withStaffModule('taxNotices');
const BLOCKING_AUTO_REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS'] as const;

function hasBlockingAutoRequest(request: { status: string } | null): boolean {
  return request?.status === 'OPEN' || request?.status === 'IN_PROGRESS';
}

function noBlockingAutoRequestWhere() {
  return {
    OR: [
      { requestId: null },
      { request: { status: { notIn: [...BLOCKING_AUTO_REQUEST_STATUSES] } } },
    ],
  };
}

export async function markDeadlineDoneAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().parse(formData.get('id'));

  await withTaxNoticesStaff(
    async (tx, { tenantId, staffId, session }) => {
      const before = await tx.taxDeadline.findUnique({
        where: { id },
        select: { status: true, clientId: true, request: { select: { status: true } } },
      });
      if (!before) throw new ActionError('Termin nicht gefunden.');
      await assertClientAccessTx(tx, session, before.clientId);
      if (before.status === 'DONE' || before.status === 'SKIPPED') return;
      if (hasBlockingAutoRequest(before.request)) {
        // TAX-DEADLINE-AUTOREQUEST-001 / TAX-CONTROL-STATUS-001: Ein DONE-
        // Termin darf nicht neben einer weiterhin offenen Mandantenanforderung
        // und deren Versandvormerkung stehen. Die Anforderung muss bewusst im
        // Request-Modul abgeschlossen werden; diese Action erfindet keinen
        // fachlichen Abschluss.
        throw new ActionError(
          'Die offene Mandantenanforderung muss vor dem Erledigen abgeschlossen werden.',
        );
      }
      // Atomarer Claim: nur offene Termine schließen (idempotent, kein
      // doppelter Audit-Eintrag bei parallelem Klick). Der Request-Guard im
      // selben UPDATE schließt auch ein paralleles Wiederöffnen fail-closed aus.
      const res = await tx.taxDeadline.updateMany({
        where: { id, status: before.status, ...noBlockingAutoRequestWhere() },
        data: { status: 'DONE', completedAt: new Date(), completedByStaff: staffId },
      });
      if (res.count === 0) return;
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: [{ resourceType: 'tax_deadline', resourceId: id }],
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'tax_deadline.complete',
        resourceType: 'tax_deadline',
        resourceId: id,
        before: { status: before.status },
        after: { status: 'DONE' },
      });
    },
    { revalidate: '/staff/tax-deadlines' },
  );
}

export async function markDeadlinesDoneAction(formData: FormData): Promise<void> {
  const ids = z.array(z.string().uuid()).parse(formData.getAll('ids').map((v) => String(v)));
  if (ids.length === 0) return;

  await withTaxNoticesStaff(
    async (tx, { tenantId, staffId, session }) => {
      // Nur offene Termine schließen — bereits erledigte/übersprungene nicht
      // anfassen (kein doppelter Audit-Eintrag, idempotent bei Mehrfachklick).
      const toClose = await tx.taxDeadline.findMany({
        where: { id: { in: ids }, status: { notIn: ['DONE', 'SKIPPED'] } },
        select: {
          id: true,
          status: true,
          clientId: true,
          request: { select: { status: true } },
        },
      });
      if (toClose.length === 0) return;
      // Vertraulich-/RESTRICTED-Ventil pro betroffenem Mandanten.
      for (const clientId of new Set(toClose.map((t) => t.clientId))) {
        await assertClientAccessTx(tx, session, clientId);
      }
      if (toClose.some((deadline) => hasBlockingAutoRequest(deadline.request))) {
        throw new ActionError(
          'Mindestens eine offene Mandantenanforderung muss vor dem Erledigen abgeschlossen werden.',
        );
      }

      // Pro Zeile exakter Status-/Request-CAS. Prisma updateMany liefert nur
      // einen Count; mit einem Sammelupdate wäre bei Teilgewinn unbekannt,
      // welche IDs tatsächlich DONE wurden. Nur gewonnene IDs dürfen danach
      // Notification-Auflösung und Audit erhalten.
      const completedAt = new Date();
      const claimed: typeof toClose = [];
      for (const deadline of toClose) {
        const changed = await tx.taxDeadline.updateMany({
          where: { id: deadline.id, status: deadline.status, ...noBlockingAutoRequestWhere() },
          data: { status: 'DONE', completedAt, completedByStaff: staffId },
        });
        if (changed.count === 1) claimed.push(deadline);
      }
      if (claimed.length === 0) return;
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: claimed.map((deadline) => ({
          resourceType: 'tax_deadline',
          resourceId: deadline.id,
        })),
      });
      for (const t of claimed) {
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'tax_deadline.complete',
          resourceType: 'tax_deadline',
          resourceId: t.id,
          before: { status: t.status },
          after: { status: 'DONE' },
        });
      }
    },
    { revalidate: '/staff/tax-deadlines' },
  );
}

// Auto-Anforderung stoppen — nur solange sie noch NICHT versendet ist
// (requestId null) und der Termin noch offen (PLANNED). Ein gestoppter
// Termin läuft regulär weiter (OVERDUE/DONE), nur der automatische Versand
// unterbleibt; der Stopp ist über unsuppressAutoRequestAction aufhebbar.
async function suppressDeadlines(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withTaxNoticesStaff(
    async (tx, { tenantId, staffId, session }) => {
      const toSuppress = await tx.taxDeadline.findMany({
        where: {
          id: { in: ids },
          status: 'PLANNED',
          requestId: null,
          autoRequestSuppressedAt: null,
        },
        select: { id: true, clientId: true, kind: true, period: true },
      });
      if (toSuppress.length === 0) return;
      // Vertraulich-/RESTRICTED-Ventil pro betroffenem Mandanten.
      for (const clientId of new Set(toSuppress.map((t) => t.clientId))) {
        await assertClientAccessTx(tx, session, clientId);
      }
      // Guard pro Zeile erneut anwenden (Race gegen den Materialize-Lauf:
      // dessen Tx-Re-Check respektiert einen gesetzten Stopp, umgekehrt darf
      // ein inzwischen versendeter Termin nicht nachträglich gestoppt werden).
      // Nur tatsächlich gewonnene IDs erhalten Notification-Auflösung/Audit.
      const suppressedAt = new Date();
      const claimed: typeof toSuppress = [];
      for (const deadline of toSuppress) {
        const changed = await tx.taxDeadline.updateMany({
          where: {
            id: deadline.id,
            status: 'PLANNED',
            requestId: null,
            autoRequestSuppressedAt: null,
          },
          data: { autoRequestSuppressedAt: suppressedAt, autoRequestSuppressedByStaff: staffId },
        });
        if (changed.count === 1) claimed.push(deadline);
      }
      if (claimed.length === 0) return;
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: claimed.map((deadline) => ({
          resourceType: 'tax_deadline',
          resourceId: deadline.id,
        })),
      });
      for (const t of claimed) {
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'tax_deadline.request_suppressed',
          resourceType: 'tax_deadline',
          resourceId: t.id,
          after: { kind: t.kind, period: t.period },
        });
      }
    },
    { revalidate: '/staff/tax-deadlines' },
  );
}

export async function suppressAutoRequestAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().parse(formData.get('id'));
  await suppressDeadlines([id]);
}

export async function suppressDeadlinesAction(formData: FormData): Promise<void> {
  const ids = z.array(z.string().uuid()).parse(formData.getAll('ids').map((v) => String(v)));
  await suppressDeadlines(ids);
}

export async function unsuppressAutoRequestAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().parse(formData.get('id'));
  await withTaxNoticesStaff(
    async (tx, { tenantId, staffId, session }) => {
      const before = await tx.taxDeadline.findUnique({
        where: { id },
        select: {
          clientId: true,
          kind: true,
          period: true,
          autoRequestSuppressedAt: true,
          autoRequestSuppressedByStaff: true,
        },
      });
      if (!before || before.autoRequestSuppressedAt === null) return;
      await assertClientAccessTx(tx, session, before.clientId);
      const changed = await tx.taxDeadline.updateMany({
        // Exakter Snapshot-CAS: Ein paralleles Entsperren und erneutes Stoppen
        // darf durch diesen stale Aufruf nicht wieder aufgehoben werden.
        where: {
          id,
          autoRequestSuppressedAt: before.autoRequestSuppressedAt,
          autoRequestSuppressedByStaff: before.autoRequestSuppressedByStaff,
        },
        data: { autoRequestSuppressedAt: null, autoRequestSuppressedByStaff: null },
      });
      if (changed.count !== 1) return;
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'tax_deadline.request_unsuppressed',
        resourceType: 'tax_deadline',
        resourceId: id,
        after: { kind: before.kind, period: before.period },
      });
    },
    { revalidate: '/staff/tax-deadlines' },
  );
}

export async function rematerializeAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard({ module: 'taxNotices' });
  if (!g.ok) return;

  // P-4: tenant-weite Materialisierung gehört nicht in eine interaktive
  // 15-s-Server-Action-Tx (P2028 bei vielen Mandanten) → BullMQ-Job; der
  // Worker (tax-deadline-materialize) übernimmt nur diesen Tenant.
  await enqueueTaxDeadlineMaterialize(g.tenantId);

  // UI-Feedback „Berechnung angestoßen" + aktuelle Ansicht beibehalten.
  const qs = new URLSearchParams({ queued: '1' });
  const view = formData.get('view');
  if (view === 'month' || view === 'list') qs.set('view', view);
  const scope = formData.get('scope');
  if (scope === 'mine' || scope === 'all') qs.set('scope', scope);
  const q = formData.get('q');
  if (typeof q === 'string' && q) qs.set('q', q.slice(0, 120));
  redirect(`/staff/tax-deadlines?${qs.toString()}`);
}
