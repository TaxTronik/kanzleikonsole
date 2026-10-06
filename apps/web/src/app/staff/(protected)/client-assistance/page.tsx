import { requireStaffPage } from '@/server/auth/staff-page';
import { requireModulePage } from '@/server/settings/module-page';
import { AssistancePage } from '@/components/client-assistance/assistance-page';
import { saveAction, reviewAction, archiveAction, reimportAction } from './actions';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireStaffPage();
  await requireModulePage('staff', 'clientAssistance');
  return (
    <AssistancePage
      surface="staff"
      search={await searchParams}
      saveAction={saveAction}
      reviewAction={reviewAction}
      archiveAction={archiveAction}
      reimportAction={reimportAction}
    />
  );
}
