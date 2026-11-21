import type { Prisma } from '@prisma/client';
import { REQUEST_STATUS_LABELS } from '@/lib/domain-labels';
import { firstListParam as first, type ListParam } from '@/lib/list-page';
import { clientAccessFilter, type ClientAccessWhere } from '@/server/auth/client-access-filter';

export interface RequestListParams {
  status?: ListParam;
  q?: ListParam;
  mine?: ListParam;
  sort?: ListParam;
  dir?: ListParam;
}

export function parseRequestListFilters(params: RequestListParams) {
  const rawStatus = first(params.status);
  const status =
    rawStatus === 'OUTSTANDING'
      ? rawStatus
      : rawStatus && Object.hasOwn(REQUEST_STATUS_LABELS, rawStatus)
        ? (rawStatus as keyof typeof REQUEST_STATUS_LABELS)
        : null;
  const rawSort = first(params.sort);
  const sort =
    rawSort === 'due' || rawSort === 'client' || rawSort === 'datev' || rawSort === 'addison'
      ? rawSort
      : 'created';
  return {
    status,
    q: first(params.q) || null,
    mine: first(params.mine) === '1',
    sort,
    dir: first(params.dir) === 'asc' ? 'asc' : 'desc',
  } as const;
}

type Filters = ReturnType<typeof parseRequestListFilters>;

export function requestListWhere(
  { status, q, mine }: Filters,
  staffId: string,
  access: ClientAccessWhere,
): Prisma.RequestWhereInput {
  const where: Prisma.RequestWhereInput = clientAccessFilter(
    access,
    mine ? { responsibilities: { some: { staffId } } } : undefined,
  );
  if (status) where.status = status === 'OUTSTANDING' ? { in: ['OPEN', 'IN_PROGRESS'] } : status;
  if (q) {
    const contains = { contains: q, mode: 'insensitive' } as const;
    where.OR = [
      { title: contains },
      { client: { name: contains } },
      { client: { datevNo: contains } },
      { client: { addisonNo: contains } },
    ];
  }
  return where;
}

export function requestListOrder({ sort, dir }: Filters): Prisma.RequestOrderByWithRelationInput[] {
  const tie = { id: 'asc' } as const;
  switch (sort) {
    case 'due':
      return [{ dueAt: { sort: dir, nulls: 'last' } }, { createdAt: 'desc' }, tie];
    case 'client':
      return [{ client: { name: dir } }, { createdAt: 'desc' }, tie];
    case 'datev':
      return [{ client: { datevNo: { sort: dir, nulls: 'last' } } }, { createdAt: 'desc' }, tie];
    case 'addison':
      return [{ client: { addisonNo: { sort: dir, nulls: 'last' } } }, { createdAt: 'desc' }, tie];
    case 'created':
      return [{ createdAt: dir }, tie];
  }
}
