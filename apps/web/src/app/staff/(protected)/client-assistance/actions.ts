'use server';
import { staffAction } from '@/server/actions/staff-action';
import {
  saveAssistance,
  reviewAssistance,
  reimportAssistance,
} from '@/server/client-assistance/service';
import { archiveAssistance } from '@/server/client-assistance/outputs';
import { assistanceFormInput } from '@/server/client-assistance/form-data';
export async function saveAction(
  _previous: { ok: boolean; error?: string; id?: string } | null,
  data: FormData,
) {
  return staffAction({
    run: () => saveAssistance('staff', assistanceFormInput(data)),
    revalidate: '/staff/client-assistance',
  });
}
export async function reviewAction(data: FormData) {
  return staffAction({
    run: async () => {
      if (data.get('confirmed') !== 'on')
        return { ok: false, error: 'Prüfung der konkreten Fassung bitte ausdrücklich bestätigen.' };
      await reviewAssistance({
        id: String(data.get('id')),
        clientId: String(data.get('clientId')),
        kind: String(data.get('kind')),
        expectedRevision: Number(data.get('revision')),
        decision: String(data.get('decision')),
        note: String(data.get('note')),
      });
    },
    revalidate: ['/staff/client-assistance', '/portal/client-assistance'],
  });
}
export async function archiveAction(data: FormData) {
  return staffAction({
    run: () =>
      archiveAssistance('staff', {
        id: String(data.get('id')),
        clientId: String(data.get('clientId')),
        kind: String(data.get('kind')),
        revision: Number(data.get('revision')),
        format: String(data.get('format')),
        shareWithClient: data.get('shareWithClient') === 'on',
      }),
    revalidate: ['/staff/client-assistance', '/portal/client-assistance'],
  });
}
export async function reimportAction(data: FormData) {
  return staffAction({
    run: () =>
      reimportAssistance('staff', {
        id: String(data.get('id')),
        clientId: String(data.get('clientId')),
        kind: String(data.get('kind')),
        expectedRevision: Number(data.get('revision')),
        documentVersionId: String(data.get('documentVersionId')),
        confirmed: data.get('confirmed') === 'on',
      }),
    revalidate: ['/staff/client-assistance', '/portal/client-assistance'],
  });
}
