// Review-Befund P-07: Sidebar und Kopfleiste (Layout) gehen sofort an den
// Browser; der Seiteninhalt streamt nach, bis dahin steht dieser Platzhalter.
//
// Bewusst keine tiefere loading-Grenze unter clients/[id]: Next 16 prefetcht
// sichtbare Links bis zur nächsten loading-Grenze und führte dann für JEDEN
// sichtbaren Mandanten-Link das [id]-Layout aus (Sitzung + Zugriffsprüfung in
// einer Transaktion), z. B. bis zu 300 Links in der Steuertermin-Liste. Das
// Cockpit streamt stattdessen seine Blöcke selbst (cockpit-blocks.tsx).
import { PageSkeleton } from '@/components/page-skeleton';

export default function StaffLoading() {
  return <PageSkeleton />;
}
