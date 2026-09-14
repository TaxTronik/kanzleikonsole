import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { hasStaffPermission, inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { WorkBasketItemRow, WORK_KIND_LABELS } from '@/components/work-basket-item';
import {
  loadWorkBasket,
  type WorkBasketBucket,
  type WorkBasketItem,
  type WorkBasketKind,
} from '@/server/work/basket';
import { portalInboxWorkExtension } from '@/server/inbox/work-extension';

interface Search {
  kind?: string;
  scope?: string;
}

type Modules = Awaited<ReturnType<typeof readModules>>;
type WorkSlot = 'mine' | 'team';

const BUCKETS: ReadonlyArray<{
  id: WorkBasketBucket;
  label: string;
}> = [
  { id: 'overdue', label: 'Überfällig' },
  { id: 'today', label: 'Heute' },
  { id: 'later', label: 'Später' },
  { id: 'undated', label: 'Ohne Termin' },
];

function selectedKindFrom(value: string | undefined): WorkBasketKind | null {
  if (!Object.hasOwn(WORK_KIND_LABELS, value ?? '')) return null;
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

function WorkBucketSection({
  bucket,
  items,
}: {
  bucket: (typeof BUCKETS)[number];
  items: WorkBasketItem[];
}) {
  return (
    <section className="card overflow-hidden" aria-labelledby={`work-${bucket.id}`}>
      <div className="flex items-center justify-between border-b border-default px-5 py-3">
        <h2 id={`work-${bucket.id}`} className="font-semibold text-primary">
          {bucket.label}
        </h2>
        <span className="text-xs tabular-nums text-muted">{items.length}</span>
      </div>
      <ul className="divide-y divide-border-subtle">
        {items.map((item) => (
          <WorkBasketItemRow key={item.key} item={item} />
        ))}
      </ul>
    </section>
  );
}

function WorkBasketContent({
  items,
  slot,
  selectedKind,
}: {
  items: WorkBasketItem[];
  slot: WorkSlot;
  selectedKind: WorkBasketKind | null;
}) {
  if (items.length === 0) {
    return (
      <section className="card p-5 sm:p-6" aria-labelledby="work-empty">
        <h2 id="work-empty" className="font-semibold text-primary">
          Keine offenen Einträge
        </h2>
        <p className="mt-1 text-sm text-muted">
          {selectedKind
            ? `Für „${WORK_KIND_LABELS[selectedKind]}“ gibt es in dieser Ansicht keine offenen Einträge.`
            : slot === 'team'
              ? 'Aktuell gibt es keine unzugeordneten Eingänge für das Kanzleiteam.'
              : 'Ihre Aufgaben, Termine und Eingänge erscheinen hier, sobald etwas ansteht.'}
        </p>
        {selectedKind && (
          <Link
            href={slot === 'team' ? '/staff/work?scope=team' : '/staff/work'}
            className="btn-secondary mt-4 text-sm"
          >
            Alle Einträge anzeigen
          </Link>
        )}
      </section>
    );
  }

  const groups = BUCKETS.map((bucket) => ({
    bucket,
    items: items.filter((item) => item.bucket === bucket.id),
  }));
  const filledGroups = groups.filter((group) => group.items.length > 0);
  const emptyGroups = groups.filter((group) => group.items.length === 0);

  return (
    <>
      <div className={`grid items-start gap-5 ${filledGroups.length > 1 ? 'xl:grid-cols-2' : ''}`}>
        {filledGroups.map(({ bucket, items: bucketItems }) => (
          <WorkBucketSection key={bucket.id} bucket={bucket} items={bucketItems} />
        ))}
      </div>
      {emptyGroups.length > 0 && (
        <p className="mt-3 text-xs text-muted">
          Ohne offene Einträge: {emptyGroups.map(({ bucket }) => bucket.label).join(' · ')}
        </p>
      )}
    </>
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
              {WORK_KIND_LABELS[itemKind]}
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

      <WorkBasketContent items={items} slot={slot} selectedKind={selectedKind} />
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
