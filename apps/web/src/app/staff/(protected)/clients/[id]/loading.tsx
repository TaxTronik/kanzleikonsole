// Route-Level-Skeleton: erscheint sofort, während die Mandanten-Cockpit-
// Server-Komponente alle Blöcke lädt. Spiegelt grob Kopfzeile + Karten-Grid.
import { Skeleton } from '@/components/skeleton';

export default function ClientDetailLoading() {
  return (
    <div className="p-8">
      <div className="mb-6">
        <Skeleton className="h-4 w-32 mb-3" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-2 h-4 w-48" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card p-5">
            <Skeleton className="mb-4 h-5 w-32" />
            <div className="space-y-2.5">
              {Array.from({ length: 4 }).map((__, j) => (
                <Skeleton key={j} className="h-4 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
