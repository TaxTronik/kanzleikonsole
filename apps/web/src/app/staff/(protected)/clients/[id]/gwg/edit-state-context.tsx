'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

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
  markInReview: () => void;
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
  const lastServerStatus = useRef(initialStatus);

  // Ein RSC-Refresh kann den Provider erhalten und nur seine Props ersetzen.
  // Synchronisiert wird deshalb ausschliesslich ein *neuer* Serverstatus. Ein
  // lokaler markDraft()-Erfolg darf nicht durch einen Effect mit derselben,
  // noch alten IN_REVIEW-Prop wieder zurueckgedreht werden.
  useEffect(() => {
    if (lastServerStatus.current === initialStatus) return;
    lastServerStatus.current = initialStatus;
    setStatus(initialStatus);
  }, [initialStatus]);

  const markDraft = useCallback(() => setStatus('DRAFT'), []);
  const markInReview = useCallback(() => setStatus('IN_REVIEW'), []);
  const value = useMemo(
    () => ({ status, markDraft, markInReview }),
    [markDraft, markInReview, status],
  );
  return <EditStateContext.Provider value={value}>{children}</EditStateContext.Provider>;
}

export function useGwgEditState(fallbackStatus: GwgStatus = 'DRAFT'): GwgEditState {
  const value = useContext(EditStateContext);
  return (
    value ?? {
      status: fallbackStatus,
      markDraft: () => undefined,
      markInReview: () => undefined,
    }
  );
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
