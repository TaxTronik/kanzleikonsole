import { AssistancePage } from '@/server/client-assistance/page';
import { requireModulePage } from '@/server/settings/module-page';
import { saveAction, archiveAction, reimportAction } from './actions';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireModulePage('portal', 'clientAssistance');
  return (
    <AssistancePage
      surface="portal"
      search={await searchParams}
      saveAction={saveAction}
      archiveAction={archiveAction}
      reimportAction={reimportAction}
    />
  );
}
