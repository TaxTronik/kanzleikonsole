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
import { GWG_CHECK_STATUS_LABELS } from '@/lib/domain-labels';

type GwgStatus = 'DRAFT' | 'IN_REVIEW' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

interface GwgEditState {
  status: GwgStatus;
  markDraft: () => void;
  markInReview: () => void;
  /**
   * Zählt hoch, wenn eine Server-Action die Risikobewertung serverseitig
   * zurückgesetzt hat (Personen-/Rechtsträger-Änderungen mit invalidateRisk).
   * Das Risiko-Formular gleicht darauf seine CAS-Revision ab, ohne dass die
   * Seite neu geladen werden muss.
   */
  riskInvalidationGeneration: number;
  markRiskInvalidated: () => void;
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
  const [riskInvalidationGeneration, setRiskInvalidationGeneration] = useState(0);
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
  const markRiskInvalidated = useCallback(
    () => setRiskInvalidationGeneration((generation) => generation + 1),
    [],
  );
  const value = useMemo(
    () => ({ status, markDraft, markInReview, riskInvalidationGeneration, markRiskInvalidated }),
    [markDraft, markInReview, markRiskInvalidated, riskInvalidationGeneration, status],
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
      riskInvalidationGeneration: 0,
      markRiskInvalidated: () => undefined,
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
      {GWG_CHECK_STATUS_LABELS[status]}
    </span>
  );
}
