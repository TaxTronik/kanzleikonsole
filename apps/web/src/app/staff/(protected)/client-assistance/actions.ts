'use server';
import { revalidatePath } from 'next/cache';
import { staffActionGuard } from '@/server/actions/staff-action';
import { toActionError } from '@/server/auth/rbac';
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
  const guard = await staffActionGuard();
  if (!guard.ok) return guard;
  try {
    const saved = await saveAssistance('staff', assistanceFormInput(data));
    revalidatePath('/staff/client-assistance');
    return { ok: true, ...saved };
  } catch (error) {
    return toActionError(error);
  }
}
export async function reviewAction(data: FormData) {
  const guard = await staffActionGuard();
  if (!guard.ok) return guard;
  try {
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
    revalidatePath('/staff/client-assistance');
    revalidatePath('/portal/client-assistance');
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
export async function archiveAction(data: FormData) {
  const guard = await staffActionGuard();
  if (!guard.ok) return guard;
  try {
    const result = await archiveAssistance('staff', {
      id: String(data.get('id')),
      clientId: String(data.get('clientId')),
      kind: String(data.get('kind')),
      revision: Number(data.get('revision')),
      format: String(data.get('format')),
      shareWithClient: data.get('shareWithClient') === 'on',
    });
    revalidatePath('/staff/client-assistance');
    revalidatePath('/portal/client-assistance');
    return { ok: true, ...result };
  } catch (error) {
    return toActionError(error);
  }
}
export async function reimportAction(data: FormData) {
  const guard = await staffActionGuard();
  if (!guard.ok) return guard;
  try {
    const result = await reimportAssistance('staff', {
      id: String(data.get('id')),
      clientId: String(data.get('clientId')),
      kind: String(data.get('kind')),
      expectedRevision: Number(data.get('revision')),
      documentVersionId: String(data.get('documentVersionId')),
      confirmed: data.get('confirmed') === 'on',
    });
    revalidatePath('/staff/client-assistance');
    revalidatePath('/portal/client-assistance');
    return { ok: true, ...result };
  } catch (error) {
    return toActionError(error);
  }
}
