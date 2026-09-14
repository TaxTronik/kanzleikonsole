import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { WorkBasketItemRow } from '@/components/work-basket-item';
import { portalInboxWorkExtension } from '@/server/inbox/work-extension';
import { loadWorkBasket } from '@/server/work/basket';
import { ListShell, type RenderCtx } from './_shared';

const PREVIEW_LIMIT = 20;
const WORK_BASKET_LOAD_LIMIT = 100;

export async function MyWorkBasket({
  tx,
  tenantId,
  staffId,
  modules,
  deniedClientIds,
  portalInboxEnabled,
}: RenderCtx) {
  const items = await loadWorkBasket({
    tx,
    staffId,
    deniedClientIds,
    slot: 'mine',
    limit: WORK_BASKET_LOAD_LIMIT,
    sources: {
      workflows: modules.workflows,
      reminders: modules.reminders,
      appointments: modules.appointments,
      phoneNotes: modules.phoneNotes,
    },
    extensions: tenantId && portalInboxEnabled ? [portalInboxWorkExtension(tenantId)] : [],
  });

  return (
    <ListShell
      icon={Inbox}
      title="Mein Arbeitskorb"
      isEmpty={items.length === 0}
      emptyText="Keine offenen Einträge in Ihrem persönlichen Arbeitskorb."
      footer={
        <div className="space-y-1">
          {items.length > PREVIEW_LIMIT && <p>Weitere Einträge im Arbeitskorb.</p>}
          <Link href="/staff/work" className="text-brand-700 hover:underline">
            Arbeitskorb öffnen →
          </Link>
        </div>
      }
    >
      {items.slice(0, PREVIEW_LIMIT).map((item) => (
        <WorkBasketItemRow key={item.key} item={item} displayBucket />
      ))}
    </ListShell>
  );
}
