'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type GwgStatus = 'DRAFT' | 'IN_REVIEW' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

const statusLabels: Record<GwgStatus, string> = {
  DRAFT: 'Entwurf',
  IN_REVIEW: 'In Prüfung',
  VERIFIED: 'Verifiziert',
  REJECTED: 'Abgelehnt',
  EXPIRED: 'Abgelaufen',
};

interface GwgEditState {
  status: GwgStatus;
  markDraft: () => void;
}

const EditStateContext = createContext<GwgEditState | null>(null);

export function GwgEditStateProvider({
  initialStatus,
  children,
}: {
  initialStatus: GwgStatus;
  children: ReactNode;
}) {
  const [status, setStatus] = useState(initialStatus);
  const markDraft = useCallback(() => setStatus('DRAFT'), []);
  const value = useMemo(() => ({ status, markDraft }), [markDraft, status]);
  return <EditStateContext.Provider value={value}>{children}</EditStateContext.Provider>;
}

export function useGwgEditState(fallbackStatus: GwgStatus = 'DRAFT'): GwgEditState {
  const value = useContext(EditStateContext);
  return value ?? { status: fallbackStatus, markDraft: () => undefined };
}

export function GwgLiveStatusBadge() {
  const { status } = useGwgEditState();
  return (
    <span
      className={
        status === 'VERIFIED'
          ? 'badge-green'
          : status === 'REJECTED' || status === 'EXPIRED'
            ? 'badge-red'
            : 'badge-yellow'
      }
    >
      {statusLabels[status]}
    </span>
  );
}
