'use server';

import { z } from 'zod';
import { parseFormData, withStaff } from '@/server/actions/staff-action';

const IdSchema = z.object({ id: z.string().uuid() });

export async function markNotificationReadAction(formData: FormData): Promise<void> {
  // F6: UUID-Validation statt nur typeof — sonst werfen Prisma-Updates erst
  // zur Laufzeit mit "Invalid uuid".
  const parsed = parseFormData(IdSchema, formData);
  if (!parsed.ok) return;
  const { id } = parsed.data;

  await withStaff(
    async (tx, { staffId }) => {
      await tx.notification.updateMany({
        where: { id, OR: [{ staffId }, { staffId: null }], readAt: null },
        data: { readAt: new Date() },
      });
    },
    { revalidate: '/staff/notifications' },
  );
}

export async function markAllNotificationsReadAction(): Promise<void> {
  await withStaff(
    async (tx, { staffId }) => {
      await tx.notification.updateMany({
        where: { OR: [{ staffId }, { staffId: null }], readAt: null },
        data: { readAt: new Date() },
      });
    },
    { revalidate: '/staff/notifications' },
  );
}
