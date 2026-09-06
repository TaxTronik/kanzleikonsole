import type { InboxTopic } from './constants';

export type InboxThreadStatus = 'OPEN' | 'RESOLVED';
export type InboxAttention = 'STAFF' | 'CLIENT' | 'NONE';
export type InboxAttachmentDecision = 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED' | 'BLOCKED';

export interface InboxAttachmentView {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: string;
  scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED';
  decision: InboxAttachmentDecision;
  acceptedDocumentId: string | null;
  rejectionReason: string | null;
  downloadHref: string | null;
}

export interface InboxMessageView {
  id: string;
  authorType: 'STAFF' | 'CLIENT_CONTACT';
  authorName: string;
  body: string;
  createdAt: Date;
  attachments: InboxAttachmentView[];
}

export interface InboxThreadListItem {
  id: string;
  clientId: string;
  clientName?: string;
  subject: string;
  topic: InboxTopic;
  status: InboxThreadStatus;
  attention: InboxAttention;
  assignedStaffId: string | null;
  assignedStaffName?: string | null;
  lastMessageAt: Date;
  unread?: boolean;
  pendingAttachmentCount?: number;
}

export interface InboxThreadDetail extends InboxThreadListItem {
  createdByContactName: string;
  resolvedAt: Date | null;
  messages: InboxMessageView[];
}
