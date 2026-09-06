import type { PersistedVerifyResult } from '@taxtronik/evidence';
import {
  AuditQuerySchema,
  auditPageWhere,
  auditQueryString,
  auditWhere,
} from '@/server/audit/query';

export const AUDIT_PAGE_SIZE = 50;
export interface SearchParams {
  cursor?: string;
  action?: string;
  actorType?: string;
  resourceType?: string;
  category?: string;
  sort?: string;
  from?: string;
  to?: string;
  verify?: string;
  requestId?: string;
  queuedAt?: string;
  checkpoint?: string;
}

/** Invalid filters must never silently turn into an unrestricted list or export. */
export function parseAuditPageQuery(sp: SearchParams) {
  const parsed = AuditQuerySchema.safeParse(
    Object.fromEntries(Object.entries(sp).map(([key, value]) => [key, value || undefined])),
  );
  const query = parsed.success ? parsed.data : AuditQuerySchema.parse({});
  const where = parsed.success ? auditPageWhere(query, sp.cursor) : { id: 0n };
  const countWhere = parsed.success ? auditWhere(query) : { id: 0n };
  const hasFilter =
    !parsed.success ||
    Boolean(
      query.action ||
      query.actorType ||
      query.resourceType ||
      query.category ||
      query.from ||
      query.to,
    );
  return {
    query,
    where,
    countWhere,
    hasFilter,
    valid: parsed.success,
    error: parsed.success ? null : parsed.error.issues.map((issue) => issue.message).join(' '),
    baseQs: auditQueryString(query),
  };
}

export type AuditPageQuery = ReturnType<typeof parseAuditPageQuery>;

export function auditPagination<T extends { id: bigint }>(entries: T[], baseQs: URLSearchParams) {
  const visibleEntries = entries.slice(0, AUDIT_PAGE_SIZE);
  const hasNext = entries.length > AUDIT_PAGE_SIZE;
  const nextCursor = hasNext ? String(visibleEntries[visibleEntries.length - 1]!.id) : null;
  const nextQs = new URLSearchParams(baseQs);
  if (nextCursor) nextQs.set('cursor', nextCursor);
  return { visibleEntries, nextCursor, nextQs };
}

/** A concurrent/nightly result newer than this request also ends polling. */
export function shouldPollAuditVerify(sp: SearchParams, result: PersistedVerifyResult | null) {
  if (sp.verify !== 'queued' || !sp.requestId) return false;
  if (!result) return true;
  if (result.requestId === sp.requestId) return false;
  const queuedAtMs = sp.queuedAt ? Date.parse(sp.queuedAt) : NaN;
  const checkedAtMs = result.checkedAt ? Date.parse(result.checkedAt) : NaN;
  return !(checkedAtMs > queuedAtMs);
}

export function auditOkResultKey(result: PersistedVerifyResult | null): string | null {
  if (!result?.ok || result.error) return null;
  return `${result.checkedAt}:${result.requestId ?? ''}`;
}
