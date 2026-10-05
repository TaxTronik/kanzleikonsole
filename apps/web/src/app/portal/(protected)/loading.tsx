// Review-Befund P-07: Sidebar und Kopfleiste (Layout) gehen sofort an den
// Browser; der Seiteninhalt streamt nach, bis dahin steht dieser Platzhalter.
import { PageSkeleton } from '@/components/page-skeleton';

export default function PortalLoading() {
  return <PageSkeleton />;
}
