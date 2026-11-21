'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/** Bereichslinks bleiben im DOM in derselben Reihenfolge wie in der Desktopansicht. */
export function ResponsiveSectionNav({
  label,
  current,
  children,
}: {
  label: string;
  current: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const linksId = useId();
  return (
    <nav aria-label={label}>
      <button
        type="button"
        className="btn-secondary w-full justify-between lg:hidden"
        aria-expanded={expanded}
        aria-controls={linksId}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-left">
          {current} <span className="text-muted">· Bereich wechseln</span>
        </span>
        <ChevronDown aria-hidden="true" className={expanded ? 'h-4 w-4 rotate-180' : 'h-4 w-4'} />
      </button>
      <div id={linksId} className={expanded ? 'mt-2 lg:mt-0' : 'hidden lg:block'}>
        {children}
      </div>
    </nav>
  );
}
