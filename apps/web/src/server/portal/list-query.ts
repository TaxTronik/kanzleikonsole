export const PORTAL_LIST_PAGE_SIZE = 25;
export const PORTAL_LIST_QUERY_MAX_LENGTH = 120;

type SearchParam = string | string[] | undefined;

export function firstPortalSearchParam(value: SearchParam): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizePortalListQuery(value: SearchParam): string {
  return (firstPortalSearchParam(value) ?? '').trim().slice(0, PORTAL_LIST_QUERY_MAX_LENGTH);
}

/** Escapes PostgreSQL LIKE wildcards used by Prisma's `contains` filter. */
export function escapePortalContainsQuery(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function parsePortalListPage(value: SearchParam): number {
  const parsed = Number.parseInt(firstPortalSearchParam(value) ?? '1', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function clampPortalListPage(page: number, totalCount: number): number {
  const totalPages = Math.max(1, Math.ceil(totalCount / PORTAL_LIST_PAGE_SIZE));
  return Math.min(Math.max(1, page), totalPages);
}
