import { NotFoundState } from '@/components/not-found-state';

// notFound() in Staff-Seiten: Sidebar und Topbar bleiben stehen.
export default function StaffNotFound() {
  return <NotFoundState links={[{ href: '/staff/dashboard', label: 'Zum Dashboard' }]} />;
}
