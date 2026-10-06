'use server';
import { portalAction } from '@/server/actions/portal-action';
import { saveAssistance, reimportAssistance } from '@/server/client-assistance/service';
import { archiveAssistance } from '@/server/client-assistance/outputs';
import { assistanceFormInput } from '@/server/client-assistance/form-data';
export async function saveAction(
  _previous: { ok: boolean; error?: string; id?: string } | null,
  data: FormData,
) {
  return portalAction({
    run: () => saveAssistance('portal', assistanceFormInput(data)),
    revalidate: '/portal/client-assistance',
  });
}
export async function archiveAction(data: FormData) {
  return portalAction({
    run: () =>
      archiveAssistance('portal', {
        id: String(data.get('id')),
        clientId: String(data.get('clientId')),
        kind: String(data.get('kind')),
        revision: Number(data.get('revision')),
        format: String(data.get('format')),
      }),
    revalidate: '/portal/client-assistance',
  });
}
export async function reimportAction(data: FormData) {
  return portalAction({
    run: () =>
      reimportAssistance('portal', {
        id: String(data.get('id')),
        clientId: String(data.get('clientId')),
        kind: String(data.get('kind')),
        expectedRevision: Number(data.get('revision')),
        documentVersionId: String(data.get('documentVersionId')),
        confirmed: data.get('confirmed') === 'on',
      }),
    revalidate: ['/portal/client-assistance', '/staff/client-assistance'],
  });
}
