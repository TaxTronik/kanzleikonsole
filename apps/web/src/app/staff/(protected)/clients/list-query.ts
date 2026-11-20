import type { ClientKind, Prisma } from '@prisma/client';
import { CLIENT_KIND_LABELS } from '@/lib/domain-labels';
import { firstListParam, type ListParam } from '@/lib/list-page';

export const CLIENT_KIND_OPTIONS = [
  { value: 'NATPERS', label: CLIENT_KIND_LABELS.NATPERS },
  { value: 'JURPERS', label: CLIENT_KIND_LABELS.JURPERS },
  { value: 'PERSGES', label: CLIENT_KIND_LABELS.PERSGES },
] as const satisfies ReadonlyArray<{ value: ClientKind; label: string }>;

// R-14: Labels zentral in lib/domain-labels; hier für bestehende Importe re-exportiert.
export { CLIENT_KIND_LABELS };

export type ClientSortKey = 'name' | 'kind' | 'datev' | 'addison' | 'created';
export type ClientSortDir = 'asc' | 'desc';

export type ClientListSearchParams = Partial<
  Record<
    'q' | 'status' | 'onboarding' | 'kind' | 'sort' | 'dir' | 'mine' | 'page' | 'denied',
    ListParam
  >
>;

export function parseClientKind(value: string | undefined): ClientKind | undefined {
  return CLIENT_KIND_OPTIONS.find((option) => option.value === value)?.value;
}

export function parseClientSort(sp: ClientListSearchParams): {
  sort: ClientSortKey;
  dir: ClientSortDir;
} {
  const raw = firstListParam(sp.sort);
  const sort: ClientSortKey =
    raw === 'kind' || raw === 'datev' || raw === 'addison' || raw === 'created' ? raw : 'name';
  const dir: ClientSortDir = firstListParam(sp.dir) === 'desc' ? 'desc' : 'asc';
  return { sort, dir };
}

export function clientOrderBy(
  sort: ClientSortKey,
  dir: ClientSortDir,
): Prisma.ClientOrderByWithRelationInput[] {
  switch (sort) {
    case 'kind':
      return [{ kind: dir }, { name: 'asc' }, { id: 'asc' }];
    case 'datev':
      return [{ datevNo: { sort: dir, nulls: 'last' } }, { name: 'asc' }, { id: 'asc' }];
    case 'addison':
      return [{ addisonNo: { sort: dir, nulls: 'last' } }, { name: 'asc' }, { id: 'asc' }];
    case 'created':
      return [{ createdAt: dir }, { id: 'asc' }];
    case 'name':
    default:
      return [{ name: dir }, { id: 'asc' }];
  }
}

export function parseClientListFilters(params: ClientListSearchParams) {
  const status = firstListParam(params.status);
  const onboarding = firstListParam(params.onboarding);
  return {
    ...parseClientSort(params),
    q: firstListParam(params.q),
    status: status === 'active' || status === 'pending' ? status : undefined,
    onboarding:
      onboarding === 'open' || onboarding === 'in_progress' || onboarding === 'complete'
        ? onboarding
        : undefined,
    kind: parseClientKind(firstListParam(params.kind)),
    mine: firstListParam(params.mine) === '1',
  } as const;
}

export function clientListWhere(
  filters: ReturnType<typeof parseClientListFilters>,
  staffId: string,
  access: Prisma.ClientWhereInput,
): Prisma.ClientWhereInput {
  const where: Prisma.ClientWhereInput = {};
  if (filters.q) {
    const contains = { contains: filters.q, mode: 'insensitive' } as const;
    where.OR = [
      { name: contains },
      { datevNo: contains },
      { addisonNo: contains },
      { vatId: contains },
    ];
  }
  if (filters.status) where.allowActive = filters.status === 'active';
  if (filters.kind) where.kind = filters.kind;
  if (filters.mine) where.responsibilities = { some: { staffId } };
  if (filters.onboarding === 'complete') {
    where.onboardingCompletedAt = { not: null };
  } else if (filters.onboarding === 'open') {
    where.onboardingCompletedAt = null;
    where.AND = [{ allowActive: false }];
    where.contacts = { none: { active: true } };
    where.gwgChecks = { none: {} };
    where.gwgInvites = { none: {} };
    where.poas = { none: {} };
    where.requests = { none: {} };
  } else if (filters.onboarding === 'in_progress') {
    where.AND = [
      { onboardingCompletedAt: null },
      {
        OR: [
          { allowActive: true },
          { contacts: { some: { active: true } } },
          { gwgChecks: { some: {} } },
          { gwgInvites: { some: {} } },
          { poas: { some: {} } },
          { requests: { some: {} } },
        ],
      },
    ];
  }
  return { AND: [where, access] };
}
