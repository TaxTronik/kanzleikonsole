import Link from 'next/link';
import { CalendarClock, CalendarDays, Inbox, ListChecks, Phone, Workflow } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { hasStaffPermission, inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { fmtDateShort, fmtDateTimeShort, fmtTimeShort } from '@/lib/fmt';
import {
  loadWorkBasket,
  type WorkBasketBucket,
  type WorkBasketItem,
  type WorkBasketKind,
} from '@/server/work/basket';
import { MyDayToggle } from '../dashboard/my-day-toggle';
import { portalInboxWorkExtension } from '@/server/inbox/work-extension';

interface Search {
  kind?: string;
  scope?: string;
}

type Modules = Awaited<ReturnType<typeof readModules>>;
type WorkSlot = 'mine' | 'team';

const KIND_LABELS: Record<WorkBasketKind, string> = {
  workflow: 'Workflows',
  reminder: 'Wiedervorlagen',
  appointment: 'Termine',
  'phone-note': 'Telefonzettel',
  'portal-inbox': 'Mandantenpost',
};

const BUCKETS: ReadonlyArray<{
  id: WorkBasketBucket;
  label: string;
  empty: string;
}> = [
  { id: 'overdue', label: 'Überfällig', empty: 'Keine überfälligen Aufgaben.' },
  { id: 'today', label: 'Heute', empty: 'Für heute ist nichts terminiert.' },
  { id: 'later', label: 'Später', empty: 'Keine späteren Termine oder Fälligkeiten.' },
  { id: 'undated', label: 'Ohne Termin', empty: 'Keine offenen Eingänge ohne Termin.' },
];

function WorkKindIcon({ kind }: { kind: WorkBasketKind }) {
  const className = 'h-3 w-3 text-muted';
  if (kind === 'workflow') return <Workflow className={className} aria-hidden="true" />;
  if (kind === 'reminder') return <CalendarClock className={className} aria-hidden="true" />;
  if (kind === 'appointment') return <CalendarDays className={className} aria-hidden="true" />;
  if (kind === 'phone-note') return <Phone className={className} aria-hidden="true" />;
  return <Inbox className={className} aria-hidden="true" />;
}

function timing(item: WorkBasketItem): string | null {
  if (item.kind === 'appointment' && item.startsAt && item.endsAt) {
    return `${fmtDateShort(item.startsAt)} · ${fmtTimeShort(item.startsAt)}–${fmtTimeShort(item.endsAt)}`;
  }
  if ((item.kind === 'workflow' || item.kind === 'reminder') && item.dueAt) {
    return `fällig ${fmtDateShort(item.dueAt)}`;
  }
  if (item.occurredAt) return `eingegangen ${fmtDateTimeShort(item.occurredAt)}`;
  return null;
}

function selectedKindFrom(value: string | undefined): WorkBasketKind | null {
  if (!Object.hasOwn(KIND_LABELS, value ?? '')) return null;
  return value as WorkBasketKind;
}

function selectedSource(
  enabled: boolean,
  selectedKind: WorkBasketKind | null,
  kind: WorkBasketKind,
): boolean {
  return enabled && (!selectedKind || selectedKind === kind);
}

function moduleSources(modules: Modules, selectedKind: WorkBasketKind | null) {
  return {
    workflows: selectedSource(modules.workflows, selectedKind, 'workflow'),
    reminders: selectedSource(modules.reminders, selectedKind, 'reminder'),
    appointments: selectedSource(modules.appointments, selectedKind, 'appointment'),
    phoneNotes: selectedSource(modules.phoneNotes, selectedKind, 'phone-note'),
  };
}

function workSlot(scope: string | undefined, inboxEnabled: boolean): WorkSlot {
  return scope === 'team' && inboxEnabled ? 'team' : 'mine';
}

function inboxExtensions(input: {
  inboxEnabled: boolean;
  selectedKind: WorkBasketKind | null;
  tenantId: string;
}) {
  if (!selectedSource(input.inboxEnabled, input.selectedKind, 'portal-inbox')) return [];
  return [portalInboxWorkExtension(input.tenantId)];
}

function availableKinds(modules: Modules, inboxEnabled: boolean, slot: WorkSlot): WorkBasketKind[] {
  if (slot === 'team') return inboxEnabled ? ['portal-inbox'] : [];
  const kinds: WorkBasketKind[] = [];
  if (modules.workflows) kinds.push('workflow');
  if (modules.reminders) kinds.push('reminder');
  if (modules.appointments) kinds.push('appointment');
  if (modules.phoneNotes) kinds.push('phone-note');
  if (inboxEnabled) kinds.push('portal-inbox');
  return kinds;
}

function WorkItemRow({ item, bucket }: { item: WorkBasketItem; bucket: WorkBasketBucket }) {
  const time = timing(item);
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      {item.kind === 'workflow' ? (
        <MyDayToggle id={item.sourceId} />
      ) : (
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-default">
          <WorkKindIcon kind={item.kind} />
        </span>
      )}
      <Link href={item.href} className="min-w-0 flex-1 rounded hover:bg-gray-50">
        <div className="flex items-start justify-between gap-2">
          <p className="item-title">{item.title}</p>
          <span className="shrink-0 text-[10px] text-disabled">{KIND_LABELS[item.kind]}</span>
        </div>
        {item.context && <p className="truncate text-xs text-muted">{item.context}</p>}
        {time && (
          <p
            className={
              bucket === 'overdue' ? 'text-xs font-medium text-red-700' : 'text-xs text-muted'
            }
          >
            {time}
          </p>
        )}
      </Link>
    </li>
  );
}

function WorkBucketSection({
  bucket,
  items,
}: {
  bucket: (typeof BUCKETS)[number];
  items: WorkBasketItem[];
}) {
  const bucketItems = items.filter((item) => item.bucket === bucket.id);
  return (
    <section className="card overflow-hidden" aria-labelledby={`work-${bucket.id}`}>
      <div className="flex items-center justify-between border-b border-default px-5 py-3">
        <h2 id={`work-${bucket.id}`} className="font-semibold text-primary">
          {bucket.label}
        </h2>
        <span className="text-xs tabular-nums text-muted">{bucketItems.length}</span>
      </div>
      {bucketItems.length === 0 ? (
        <p className="px-5 py-6 text-sm text-disabled">{bucket.empty}</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {bucketItems.map((item) => (
            <WorkItemRow key={item.key} item={item} bucket={bucket.id} />
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkFilters({
  slot,
  inboxEnabled,
  selectedKind,
  kinds,
}: {
  slot: WorkSlot;
  inboxEnabled: boolean;
  selectedKind: WorkBasketKind | null;
  kinds: WorkBasketKind[];
}) {
  return (
    <>
      {inboxEnabled && (
        <nav aria-label="Arbeitskorb-Ansicht" className="mb-5 flex gap-2">
          <Link
            href="/staff/work"
            className={slot === 'mine' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
            aria-current={slot === 'mine' ? 'page' : undefined}
          >
            Meine Arbeit
          </Link>
          <Link
            href="/staff/work?scope=team"
            className={slot === 'team' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
            aria-current={slot === 'team' ? 'page' : undefined}
          >
            Team
          </Link>
        </nav>
      )}

      {kinds.length > 1 && (
        <nav aria-label="Arbeitskorb filtern" className="mb-5 flex flex-wrap gap-2">
          <Link
            href={slot === 'team' ? '/staff/work?scope=team' : '/staff/work'}
            className={selectedKind ? 'btn-secondary text-xs' : 'btn-primary text-xs'}
          >
            Alle
          </Link>
          {kinds.map((itemKind) => (
            <Link
              key={itemKind}
              href={`/staff/work?${slot === 'team' ? 'scope=team&' : ''}kind=${encodeURIComponent(itemKind)}`}
              className={
                selectedKind === itemKind ? 'btn-primary text-xs' : 'btn-secondary text-xs'
              }
            >
              {KIND_LABELS[itemKind]}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}

function WorkBasketView({
  slot,
  inboxEnabled,
  selectedKind,
  kinds,
  items,
}: {
  slot: WorkSlot;
  inboxEnabled: boolean;
  selectedKind: WorkBasketKind | null;
  kinds: WorkBasketKind[];
  items: WorkBasketItem[];
}) {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-primary">
            <ListChecks className="h-6 w-6 text-brand-600" aria-hidden="true" />
            Arbeitskorb
          </h1>
          <p className="mt-1 text-sm text-muted">
            {slot === 'mine'
              ? 'Meine offenen Aufgaben, Termine und Eingänge an einem Ort.'
              : 'Unzugeordnete Eingänge für das Kanzleiteam.'}
          </p>
        </div>
        <span className="badge-brand">
          {slot === 'mine' ? 'Meine Arbeit' : 'Team'} · {items.length}
        </span>
      </div>

      <WorkFilters
        slot={slot}
        inboxEnabled={inboxEnabled}
        selectedKind={selectedKind}
        kinds={kinds}
      />

      {items.length >= 100 && (
        <p role="status" className="alert-warning mb-4 text-sm">
          Es werden die 100 zeitlich wichtigsten Einträge angezeigt. Die Fachlisten enthalten den
          vollständigen Bestand.
        </p>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        {BUCKETS.map((bucket) => (
          <WorkBucketSection key={bucket.id} bucket={bucket} items={items} />
        ))}
      </div>
    </div>
  );
}

export default async function WorkPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
  // Module VOR den Datenqueries aufloesen: ein deaktivierter Bereich wird
  // weder gerendert noch im Hintergrund abgefragt.
  const modules = await readModules(ctx);
  const portalFeatures = await readPortalFeatures(ctx);
  const inboxEnabled =
    portalFeatures.clientInbox && hasStaffPermission(session, 'PORTAL_INBOX_MANAGE');
  const query = await searchParams;
  const selectedKind = selectedKindFrom(query.kind);
  const slot = workSlot(query.scope, inboxEnabled);
  const items = await withTenantContext(ctx, async (tx) => {
    const deniedClientIds = await inaccessibleClientIdsFor(tx, session);
    return loadWorkBasket({
      tx,
      staffId,
      deniedClientIds,
      sources: moduleSources(modules, selectedKind),
      slot,
      limit: 100,
      extensions: inboxExtensions({ inboxEnabled, selectedKind, tenantId }),
    });
  });

  return (
    <WorkBasketView
      slot={slot}
      inboxEnabled={inboxEnabled}
      selectedKind={selectedKind}
      kinds={availableKinds(modules, inboxEnabled, slot)}
      items={items}
    />
  );
}
