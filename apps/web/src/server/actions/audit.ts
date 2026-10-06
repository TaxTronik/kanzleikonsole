// =============================================================================
// Audit-Ereignis einer Server-Action (Review-Befund R-12).
//
// Mandant und Akteur eines Audit-Eintrags sind die des Tenant-Kontexts, mit dem
// das Gate die Transaktion öffnet (`g.ctx` aus staffActionGuard/withStaff/
// staffAction bzw. dem Portal-Pendant). Statt das Tripel tenantId/actorType/
// actorId an jedem evidenceService.record-Aufruf von Hand zu übertragen, nimmt
// `audit(tx, g, event)` es aus diesem Kontext:
//
//   await audit(tx, g, { action: 'kb.article.delete', resourceType: 'kb_article',
//                        resourceId: id, before: { title } });
//
// Das an evidenceService.record übergebene Ereignis ist feldgleich zum
// handgeschriebenen Aufruf; in den Hash der Audit-Kette gehen dieselben Werte
// (Nachweis: __tests__/audit.test.ts). Das Tripel aus dem Kontext hat Vorrang —
// ein Ereignis kann Mandant oder Akteur nicht überschreiben.
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import type { AuditEventInput, RecordedEvent } from '@taxtronik/evidence';
import { evidenceService } from '@/server/container';

/** Audit-Ereignis ohne das Akteur-Tripel (tenantId, actorType, actorId). */
export type ActionAuditEvent = Omit<AuditEventInput, 'tenantId' | 'actorType' | 'actorId'>;

/** Gate-Kontext (StaffCtx, PortalCtx) oder direkt dessen Tenant-Kontext. */
export type AuditActor = TenantContext | { ctx: TenantContext };

type EvidenceTx = Parameters<typeof evidenceService.record>[0];

/** Schreibt ein Audit-Ereignis im Namen des Akteurs der laufenden Action. */
export function audit(
  tx: EvidenceTx,
  actor: AuditActor,
  event: ActionAuditEvent,
): Promise<RecordedEvent> {
  const ctx = 'ctx' in actor ? actor.ctx : actor;
  return evidenceService.record(tx, {
    ...event,
    tenantId: ctx.tenantId,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
  });
}
