import { Skeleton } from '@/components/skeleton';

export default function WorkflowsLoading() {
  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-2 h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="mb-5 flex gap-3">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-9 w-64" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="card p-5">
            <div className="flex items-center justify-between gap-6">
              <div className="flex-1 space-y-3">
                <Skeleton className="h-5 w-2/5" />
                <Skeleton className="h-4 w-3/5" />
              </div>
              <Skeleton className="h-7 w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
