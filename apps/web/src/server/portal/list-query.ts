import { firstListParam, parseListPage, clampListPage } from '@/lib/list-page';

export const PORTAL_LIST_PAGE_SIZE = 25;
export const PORTAL_LIST_QUERY_MAX_LENGTH = 120;

type SearchParam = string | string[] | undefined;

export { firstListParam as firstPortalSearchParam, parseListPage as parsePortalListPage };

export function normalizePortalListQuery(value: SearchParam): string {
  return (firstListParam(value) ?? '').trim().slice(0, PORTAL_LIST_QUERY_MAX_LENGTH);
}

/** Escapes PostgreSQL LIKE wildcards used by Prisma's `contains` filter. */
export function escapePortalContainsQuery(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function clampPortalListPage(page: number, totalCount: number): number {
  return clampListPage(page, totalCount, PORTAL_LIST_PAGE_SIZE);
}
