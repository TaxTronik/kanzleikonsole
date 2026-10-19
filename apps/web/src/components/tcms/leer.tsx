// Leerzustand einer Karte oder Liste (TCMS Stufe 3, aus der Demo components/ui/leer.tsx).
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function TcmsLeer({
  icon: Icon,
  text,
  children,
}: {
  icon: LucideIcon;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="text-center px-6 py-10">
      <Icon className="h-8 w-8 text-muted mx-auto" aria-hidden="true" />
      <p className="text-sm text-muted mt-2">{text}</p>
      {children ? <div className="mt-4 flex justify-center gap-2">{children}</div> : null}
    </div>
  );
}
