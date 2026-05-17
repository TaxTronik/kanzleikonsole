'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';

const IdSchema = z.object({ id: z.string().uuid() });

export async function markNotificationReadAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) return;
  // F6: UUID-Validation statt nur typeof — sonst werfen Prisma-Updates erst
  // zur Laufzeit mit "Invalid uuid".
  const parsed = IdSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return;
  const { id } = parsed.data;

  const { tenantId, staffId } = session.user;
  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.notification.updateMany({
        where: { id, OR: [{ staffId }, { staffId: null }], readAt: null },
        data: { readAt: new Date() },
      }),
  );
  revalidatePath('/staff/notifications');
}

export async function markAllNotificationsReadAction(): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) return;
  const { tenantId, staffId } = session.user;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.notification.updateMany({
        where: { OR: [{ staffId }, { staffId: null }], readAt: null },
        data: { readAt: new Date() },
      }),
  );
  revalidatePath('/staff/notifications');
}
