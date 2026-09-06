import { requireStaffPage } from '@/server/auth/staff-page';
import { AssistancePage } from '@/server/client-assistance/page';
import { saveAction, reviewAction, archiveAction, reimportAction } from './actions';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireStaffPage();
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
