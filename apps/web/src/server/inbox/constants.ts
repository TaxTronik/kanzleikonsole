// Fachkatalog: PORTAL-INBOX-SUBMISSION-001 (ungepruefter Entwurf),
// ACCESS-SEARCH-SCOPE-001 (ungepruefter Entwurf).

export const INBOX_PAGE_SIZE = 25;
export const INBOX_STAFF_PAGE_SIZE = 50;
export const INBOX_SUBJECT_MAX_LENGTH = 160;
export const INBOX_MESSAGE_MAX_LENGTH = 10_000;
export const INBOX_MAX_ATTACHMENTS = 10;
export const INBOX_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const INBOX_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const INBOX_MAX_OPEN_BATCHES = 3;
export const INBOX_BATCH_TTL_MS = 24 * 60 * 60 * 1000;

export const INBOX_ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/xml',
  'text/xml',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
]);

export const INBOX_TOPICS = ['GENERAL', 'DOCUMENTS', 'BILLING', 'APPOINTMENT', 'OTHER'] as const;
export type InboxTopic = (typeof INBOX_TOPICS)[number];

export const INBOX_TOPIC_LABELS: Readonly<Record<InboxTopic, string>> = {
  GENERAL: 'Allgemeine Frage',
  DOCUMENTS: 'Unterlagen',
  BILLING: 'Rechnung',
  APPOINTMENT: 'Termin',
  OTHER: 'Sonstiges',
};

export function isAllowedInboxMime(value: string | null | undefined): value is string {
  return Boolean(value && INBOX_ALLOWED_MIME_TYPES.has(value.toLowerCase()));
}

export function sanitizeInboxOriginalName(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, '')
      .replace(/[\\/]/g, '_')
      .trim()
      .slice(0, 255) || 'anlage'
  );
}

export function inboxBatchExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + INBOX_BATCH_TTL_MS);
}
