import { redirect } from 'next/navigation';
import { requireStaffPage } from '@/server/auth/staff-page';

export default async function SettingsIndex() {
  await requireStaffPage({ admin: true });
  redirect('/staff/admin/settings/branding');
}
