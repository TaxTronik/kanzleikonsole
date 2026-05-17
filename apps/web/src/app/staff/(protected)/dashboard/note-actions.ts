'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const BodySchema = z.string().min(1).max(5000);

export async function addNoteAction(input: { body: string }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = BodySchema.safeParse(input.body);
  if (!parsed.success) return { ok: false, error: 'Notiz darf nicht leer sein.' };
  const { tenantId, staffId } = session.user;

  const note = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.staffNote.create({
        data: { tenantId, staffId, body: parsed.data.trim() },
      }),
  );

  revalidatePath('/staff/dashboard');
  return { ok: true, id: note.id };
}

const UpdateSchema = z.object({
  id: z.string().uuid(),
  body: BodySchema,
});

export async function updateNoteAction(input: z.infer<typeof UpdateSchema>): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Notiz darf nicht leer sein.' };
  const { tenantId, staffId } = session.user;

  const r = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.staffNote.updateMany({
        where: { id: parsed.data.id, staffId },
        data: { body: parsed.data.body.trim() },
      }),
  );
  if (r.count === 0) return { ok: false, error: 'Notiz nicht gefunden.' };

  revalidatePath('/staff/dashboard');
  return { ok: true };
}

export async function deleteNoteAction(input: { id: string }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.staffNote.deleteMany({
        where: { id: parsed.data.id, staffId },
      }),
  );

  revalidatePath('/staff/dashboard');
  return { ok: true };
}
