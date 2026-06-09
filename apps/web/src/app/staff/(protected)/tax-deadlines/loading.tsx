// Route-Level-Skeleton: erscheint sofort, während die Steuertermin-Übersicht
// (Monats-Kalender bzw. Liste) serverseitig lädt.
import { Skeleton } from '@/components/skeleton';

export default function TaxDeadlinesLoading() {
  return (
    <div className="p-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-2 h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-56" />
      </div>
      <div className="grid grid-cols-7 gap-px">
        {Array.from({ length: 35 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-none" />
        ))}
      </div>
    </div>
  );
}
