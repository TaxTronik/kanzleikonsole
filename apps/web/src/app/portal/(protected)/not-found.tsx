import { NotFoundState } from '@/components/not-found-state';

// notFound() in Portal-Seiten: Navigation des Mandantenportals bleibt stehen.
export default function PortalNotFound() {
  return <NotFoundState links={[{ href: '/portal/dashboard', label: 'Zur Übersicht' }]} />;
}
