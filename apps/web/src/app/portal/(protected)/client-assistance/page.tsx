import { AssistancePage } from '@/server/client-assistance/page';
import { saveAction, archiveAction, reimportAction } from './actions';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
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
