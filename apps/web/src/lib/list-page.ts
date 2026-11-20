export type ListParam = string | string[] | null | undefined;

export function firstListParam(value: ListParam): string | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

export function parseListPage(value: ListParam): number {
  const raw = firstListParam(value);
  if (!raw || !/^\d+$/.test(raw)) return 1;
  const page = Number(raw);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function clampListPage(page: number, totalCount: number, pageSize: number): number {
  return Math.min(Math.max(1, page), Math.max(1, Math.ceil(totalCount / pageSize)));
}
