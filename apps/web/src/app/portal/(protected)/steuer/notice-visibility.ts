export interface PortalNoticeDeadlineState {
  status: string;
  deadlineCalculationStatus: string;
  manualReviewRequired: boolean;
  appealDeadline: Date | null;
}

/**
 * Ein Mandant darf keinen intern noch ungeprüften Kontrollvorschlag als
 * belastbare Fristanzeige erhalten.
 */
export function shouldShowAppealDeadlineToClient(notice: PortalNoticeDeadlineState): boolean {
  return (
    notice.deadlineCalculationStatus === 'CALCULATED' &&
    !notice.manualReviewRequired &&
    notice.appealDeadline !== null &&
    ['GEPRUEFT', 'EINSPRUCH'].includes(notice.status)
  );
}
