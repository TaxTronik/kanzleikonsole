import type { TxClient } from '@taxtronik/db';
import { berlinTodayUtcMidnight } from '@/lib/fmt';
import { loadMyDayEntries, type MyDayEntry, type MyDaySources } from '@/server/dashboard/my-day';

export type WorkBasketKind = MyDayEntry['kind'] | 'portal-inbox';
export type WorkBasketSlot = 'mine' | 'team';
export type WorkBasketBucket = 'overdue' | 'today' | 'later' | 'undated';

export const WORK_BASKET_SOURCE_SLOTS = {
  workflow: ['mine'],
  reminder: ['mine'],
  appointment: ['mine'],
  'phone-note': ['mine'],
  // Der konkrete Inbox-Loader wird separat eingesteckt. Der Vertrag traegt
  // bereits persoenliche und Team-Zustaendigkeit, ohne die bestehende Query
  // an ein noch nicht abgeschlossenes Inbox-Datenmodell zu koppeln.
  'portal-inbox': ['mine', 'team'],
} as const satisfies Record<WorkBasketKind, readonly WorkBasketSlot[]>;

export interface WorkBasketItem {
  key: string;
  kind: WorkBasketKind;
  slot: WorkBasketSlot;
  title: string;
  context: string;
  href: string;
  bucket: WorkBasketBucket;
  sortAt: Date | null;
  dueAt?: Date | null;
  startsAt?: Date;
  endsAt?: Date;
  occurredAt?: Date;
  sourceId: string;
}

/** Oeffentlicher, quellneutraler UI-Vertrag aus dem 0.3.0-Arbeitskorb. */
export type WorkItemView = WorkBasketItem;

export interface WorkBasketLoadContext {
  tx: TxClient;
  staffId: string;
  deniedClientIds?: string[];
  now: Date;
  slot: WorkBasketSlot;
  limit: number;
}

export interface WorkBasketExtension {
  kind: 'portal-inbox';
  slots: readonly WorkBasketSlot[];
  load(context: WorkBasketLoadContext): Promise<WorkBasketItem[]>;
}

export interface LoadWorkBasketInput {
  tx: TxClient;
  staffId: string;
  deniedClientIds?: string[];
  now?: Date;
  slot?: WorkBasketSlot;
  sources: MyDaySources;
  limit?: number;
  extensions?: readonly WorkBasketExtension[];
}

export function workBasketBucket(
  entry: Pick<WorkBasketItem, 'kind' | 'dueAt' | 'startsAt'>,
  now: Date,
): WorkBasketBucket {
  const today = berlinTodayUtcMidnight(now).getTime();
  if (entry.kind === 'appointment' && entry.startsAt) {
    const starts = berlinTodayUtcMidnight(entry.startsAt).getTime();
    if (starts < today) return 'overdue';
    return starts === today ? 'today' : 'later';
  }
  if (entry.kind === 'workflow' || entry.kind === 'reminder') {
    if (!entry.dueAt) return 'undated';
    const due = berlinTodayUtcMidnight(entry.dueAt).getTime();
    if (due < today) return 'overdue';
    return due === today ? 'today' : 'later';
  }
  return 'undated';
}

function fromMyDay(entry: MyDayEntry, now: Date): WorkBasketItem {
  const common = {
    key: `${entry.kind}:${entry.id}`,
    kind: entry.kind,
    slot: 'mine' as const,
    title: entry.title,
    context: entry.context,
    href: entry.href,
    sortAt: entry.sortAt,
    sourceId: entry.id,
  };
  if (entry.kind === 'workflow' || entry.kind === 'reminder') {
    const item = { ...common, dueAt: entry.dueAt };
    return { ...item, bucket: workBasketBucket(item, now) };
  }
  if (entry.kind === 'appointment') {
    const item = { ...common, startsAt: entry.startsAt, endsAt: entry.endsAt };
    return { ...item, bucket: workBasketBucket(item, now) };
  }
  const item = { ...common, occurredAt: entry.receivedAt };
  return { ...item, bucket: 'undated' };
}

const BUCKET_ORDER: Record<WorkBasketBucket, number> = {
  overdue: 0,
  today: 1,
  later: 2,
  undated: 3,
};

export async function loadWorkBasket(input: LoadWorkBasketInput): Promise<WorkBasketItem[]> {
  const now = input.now ?? new Date();
  const slot = input.slot ?? 'mine';
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
  const context: WorkBasketLoadContext = {
    tx: input.tx,
    staffId: input.staffId,
    deniedClientIds: input.deniedClientIds,
    now,
    slot,
    limit,
  };

  const builtIn =
    slot === 'mine'
      ? (
          await loadMyDayEntries(
            input.tx,
            input.staffId,
            input.deniedClientIds,
            now,
            input.sources,
            limit,
          )
        ).map((entry) => fromMyDay(entry, now))
      : [];

  const extensionItems = (
    await Promise.all(
      (input.extensions ?? [])
        .filter((extension) => extension.slots.includes(slot))
        .map((extension) => extension.load(context)),
    )
  ).flat();

  return [...builtIn, ...extensionItems]
    .sort((a, b) => {
      const byBucket = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
      if (byBucket) return byBucket;
      if (a.sortAt === null) return b.sortAt === null ? a.title.localeCompare(b.title, 'de') : 1;
      if (b.sortAt === null) return -1;
      return a.sortAt.getTime() - b.sortAt.getTime() || a.title.localeCompare(b.title, 'de');
    })
    .slice(0, limit);
}
