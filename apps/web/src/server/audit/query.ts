import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { berlinDayStartUtc, berlinWallClockToUtc } from '@/lib/fmt';
import { ACTION_LABELS } from './labels';

/** Read-time classification only: never rewrite the immutable audit event. */
export const AUDIT_CATEGORIES = {
  gwg: 'GwG',
  clients: 'Mandanten / Stammdaten',
  taxes: 'Steuern / Fristen',
  documents: 'Dokumente / Kommunikation',
  billing: 'Abrechnung / Zeiten',
  privacy: 'Datenschutz',
  tcms: 'TCMS',
  administration: 'Verwaltung / Sicherheit',
  other: 'Sonstige',
} as const;
export type AuditCategory = keyof typeof AUDIT_CATEGORIES;

function knownCategory(action: string): AuditCategory {
  if (action === 'client.tax_master_data.update') return 'taxes';
  if (
    action.startsWith('gwg.') ||
    ['client.update.gwg_relevant', 'client.deactivate.gwg_expired'].includes(action)
  )
    return 'gwg';
  if (/^(dsgvo\.|client\.anonymize|poa\.signer\.anonymize)/.test(action)) return 'privacy';
  if (/^(risk\.|subsumtion\.)/.test(action)) return 'tcms';
  if (/^(tax_|tax\.|elster\.|deadline\.|deadline_)/.test(action)) return 'taxes';
  if (/^(invoice\.|invoice_category\.|time_entry\.|bwa_|bwa\.)/.test(action)) return 'billing';
  if (
    /^(document[_.]|request[_.]|phone_note\.|poa\.|form[_.]|client_handover\.|pending_binder\.)/.test(
      action,
    )
  )
    return 'documents';
  if (/^(client[_.]|client\.)/.test(action)) return 'clients';
  if (
    /^(staff[_.]|tenant\.|auth\.|audit\.|backup\.|compliance\.|workflow[_.]|email_template\.|service_provider\.|vacation\.|vacation_request\.|sick_leave\.|absence\.|kb_|appointment[_.]|rss_feed\.|state_machine\.)/.test(
      action,
    )
  )
    return 'administration';
  return 'other';
}

const CLASSIFIED_ACTIONS = Object.keys(ACTION_LABELS).filter(
  (action) => knownCategory(action) !== 'other',
);

export function auditCategory(action: string): AuditCategory {
  return Object.hasOwn(ACTION_LABELS, action) ? knownCategory(action) : 'other';
}

const categories = Object.keys(AUDIT_CATEGORIES) as [AuditCategory, ...AuditCategory[]];
export const AuditQuerySchema = z
  .object({
    action: z.string().max(200).optional(),
    actorType: z.enum(['STAFF', 'CLIENT_CONTACT', 'SYSTEM']).optional(),
    resourceType: z.string().max(200).optional(),
    category: z.enum(categories).optional(),
    sort: z.enum(['newest', 'oldest']).default('newest'),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'Von darf nicht nach Bis liegen.',
  });
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export function auditWhere(q: AuditQuery): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (q.action) where.action = { contains: q.action, mode: 'insensitive' };
  if (q.actorType) where.actorType = q.actorType;
  if (q.resourceType) where.resourceType = q.resourceType;
  if (q.category) {
    where.AND = [
      {
        action:
          q.category === 'other'
            ? { notIn: CLASSIFIED_ACTIONS }
            : { in: CLASSIFIED_ACTIONS.filter((action) => auditCategory(action) === q.category) },
      },
    ];
  }
  if (q.from || q.to) {
    where.occurredAt = {
      ...(q.from ? { gte: berlinDayStartUtc(q.from)! } : {}),
      // Exclusive next midnight includes PostgreSQL microseconds at day end.
      // Resolve a whole second: the legacy millisecond end-of-day helper rounds offsets.
      ...(q.to ? { lt: new Date(berlinWallClockToUtc(`${q.to}T23:59:59`)!.getTime() + 1000) } : {}),
    };
  }
  return where;
}

export function auditPageWhere(q: AuditQuery, cursor?: string): Prisma.AuditLogWhereInput {
  const where = auditWhere(q);
  if (cursor && /^[1-9][0-9]{0,18}$/.test(cursor) && BigInt(cursor) <= 9223372036854775807n) {
    where.id = q.sort === 'oldest' ? { gt: BigInt(cursor) } : { lt: BigInt(cursor) };
  }
  return where;
}

export function auditQueryString(q: AuditQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(q)) if (value) params.set(key, value);
  return params;
}
