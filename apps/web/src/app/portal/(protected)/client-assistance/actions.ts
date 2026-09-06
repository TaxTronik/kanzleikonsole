'use server';
import { revalidatePath } from 'next/cache';
import { portalActionGuard } from '@/server/actions/portal-action';
import { toActionError } from '@/server/auth/rbac';
import { saveAssistance, reimportAssistance } from '@/server/client-assistance/service';
import { archiveAssistance } from '@/server/client-assistance/outputs';
import { assistanceFormInput } from '@/server/client-assistance/form-data';
export async function saveAction(
  _previous: { ok: boolean; error?: string; id?: string } | null,
  data: FormData,
) {
  const guard = await portalActionGuard();
  if (!guard.ok) return guard;
  try {
    const saved = await saveAssistance('portal', assistanceFormInput(data));
    revalidatePath('/portal/client-assistance');
    return { ok: true, ...saved };
  } catch (error) {
    return toActionError(error);
  }
}
export async function archiveAction(data: FormData) {
  const guard = await portalActionGuard();
  if (!guard.ok) return guard;
  try {
    const result = await archiveAssistance('portal', {
      id: String(data.get('id')),
      clientId: String(data.get('clientId')),
      kind: String(data.get('kind')),
      revision: Number(data.get('revision')),
      format: String(data.get('format')),
    });
    revalidatePath('/portal/client-assistance');
    return { ok: true, ...result };
  } catch (error) {
    return toActionError(error);
  }
}
export async function reimportAction(data: FormData) {
  const guard = await portalActionGuard();
  if (!guard.ok) return guard;
  try {
    const result = await reimportAssistance('portal', {
      id: String(data.get('id')),
      clientId: String(data.get('clientId')),
      kind: String(data.get('kind')),
      expectedRevision: Number(data.get('revision')),
      documentVersionId: String(data.get('documentVersionId')),
      confirmed: data.get('confirmed') === 'on',
    });
    revalidatePath('/portal/client-assistance');
    revalidatePath('/staff/client-assistance');
    return { ok: true, ...result };
  } catch (error) {
    return toActionError(error);
  }
}
