'use server';
import { withStaff, type ActionResult } from '@/server/actions/staff-action';
import { revalidatePath } from 'next/cache';
import {
  BindGwgStructureInput,
  bindGwgStructureTx,
} from '@/server/mandate-expansion/gwg-structure';
export async function bindGwgStructureAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const input = BindGwgStructureInput.safeParse({
    clientId: form.get('clientId'),
    checkId: form.get('checkId'),
    versionId: form.get('versionId'),
    expectedBindingRevision: Number(form.get('expectedBindingRevision')),
    note: form.get('note'),
    confirmed: form.get('confirmed') === 'on',
  });
  if (!input.success)
    return {
      ok: false,
      error:
        'Prüfung, Strukturversion, erläuternden Vermerk und ausdrückliche Bestätigung angeben.',
    };
  const result = await withStaff(
    async (tx, { session }) => {
      await bindGwgStructureTx(tx, session, input.data);
    },
    { module: 'mandateStructure', revalidate: '/staff/mandate-expansion/structure' },
  );
  if (result.ok) revalidatePath(`/staff/clients/${input.data.clientId}/gwg`);
  return result;
}
