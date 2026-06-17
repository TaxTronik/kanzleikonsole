import { Loader2 } from 'lucide-react';

export default function Loading() {
  return (
    <div className="p-8 flex items-center justify-center gap-2 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin" />
      Lade Rechnung…
    </div>
  );
}
