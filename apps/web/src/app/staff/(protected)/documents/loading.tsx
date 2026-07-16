import { Skeleton } from '@/components/skeleton';

export default function DocumentsLoading() {
  return (
    <div className="p-8">
      <Skeleton className="mb-5 h-4 w-56" />
      <div className="mb-4 flex items-center gap-3">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid grid-cols-[240px_1fr] gap-4">
        <div className="card space-y-3 p-4">
          {Array.from({ length: 7 }).map((_, index) => (
            <Skeleton key={index} className="h-5 w-full" />
          ))}
        </div>
        <div className="card divide-y divide-border-subtle overflow-hidden">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="flex items-center gap-5 px-5 py-4">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
