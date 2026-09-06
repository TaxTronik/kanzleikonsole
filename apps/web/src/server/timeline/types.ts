export type TimelineEventKind =
  | 'document_uploaded'
  | 'request_opened'
  | 'request_closed'
  | 'request_response_staff'
  | 'request_response_client'
  | 'phone_note'
  | 'invoice_created'
  | 'invoice_sent'
  | 'invoice_paid'
  | 'gwg_created'
  | 'gwg_verified'
  | 'gwg_rejected'
  | 'poa_created'
  | 'poa_signed'
  | 'poa_revoked'
  | 'tax_notice_received'
  | 'tax_deadline_completed'
  | 'workflow_item_done'
  | 'risk_analysis_created'
  | 'risk_analysis_archived';

export interface TimelineEvent {
  id: string;
  occurredAt: Date;
  kind: TimelineEventKind;
  title: string;
  detail?: string;
  href?: string;
}

export interface TimelineOptions {
  clientId: string;
  limit?: number;
  /** Strikt ältere Ereignisse; gleiche Zeitpunkte werden vollständig ausgeschlossen. */
  before?: Date;
}
