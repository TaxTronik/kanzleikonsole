import type { ClientKind, Prisma } from '@prisma/client';

export const CLIENT_KIND_OPTIONS = [
  { value: 'NATPERS', label: 'Natürliche Person' },
  { value: 'JURPERS', label: 'Juristische Person' },
  { value: 'PERSGES', label: 'Personengesellschaft' },
] as const satisfies ReadonlyArray<{ value: ClientKind; label: string }>;

export const CLIENT_KIND_LABELS: Readonly<Record<ClientKind, string>> = {
  NATPERS: 'Natürliche Person',
  JURPERS: 'Juristische Person',
  PERSGES: 'Personengesellschaft',
};

export type ClientSortKey = 'name' | 'kind' | 'datev' | 'addison' | 'created';
export type ClientSortDir = 'asc' | 'desc';

export interface ClientListSearchParams {
  q?: string;
  status?: 'active' | 'pending';
  onboarding?: 'open' | 'in_progress' | 'complete';
  kind?: string;
  sort?: string;
  dir?: string;
  mine?: '1';
  page?: string;
  denied?: string;
}

export function parseClientKind(value: string | undefined): ClientKind | undefined {
  return CLIENT_KIND_OPTIONS.find((option) => option.value === value)?.value;
}

export function parseClientSort(sp: ClientListSearchParams): {
  sort: ClientSortKey;
  dir: ClientSortDir;
} {
  const sort: ClientSortKey =
    sp.sort === 'kind' || sp.sort === 'datev' || sp.sort === 'addison' || sp.sort === 'created'
      ? sp.sort
      : 'name';
  const dir: ClientSortDir = sp.dir === 'desc' ? 'desc' : 'asc';
  return { sort, dir };
}

export function clientOrderBy(
  sort: ClientSortKey,
  dir: ClientSortDir,
): Prisma.ClientOrderByWithRelationInput[] {
  switch (sort) {
    case 'kind':
      return [{ kind: dir }, { name: 'asc' }];
    case 'datev':
      return [{ datevNo: { sort: dir, nulls: 'last' } }, { name: 'asc' }];
    case 'addison':
      return [{ addisonNo: { sort: dir, nulls: 'last' } }, { name: 'asc' }];
    case 'created':
      return [{ createdAt: dir }];
    case 'name':
    default:
      return [{ name: dir }];
  }
}
