import { describe, expect, it } from 'vitest';
import {
  INBOX_BATCH_TTL_MS,
  INBOX_MAX_ATTACHMENTS,
  INBOX_MAX_FILE_BYTES,
  INBOX_MAX_OPEN_BATCHES,
  INBOX_MAX_TOTAL_BYTES,
  INBOX_PAGE_SIZE,
  inboxBatchExpiresAt,
  isAllowedInboxMime,
  sanitizeInboxOriginalName,
} from '../constants';

describe('PORTAL-INBOX-SUBMISSION-001 technische Eingangsgrenzen', () => {
  it('fixiert Pagination, Batch- und Dateigrenzen des öffentlichen Vertrags', () => {
    expect(INBOX_PAGE_SIZE).toBe(25);
    expect(INBOX_MAX_ATTACHMENTS).toBe(10);
    expect(INBOX_MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
    expect(INBOX_MAX_TOTAL_BYTES).toBe(100 * 1024 * 1024);
    expect(INBOX_MAX_OPEN_BATCHES).toBe(3);
  });

  it('erlaubt nur die dokumentierte Start-Whitelist', () => {
    for (const mime of [
      'application/pdf',
      'application/xml',
      'text/xml',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/tiff',
    ]) {
      expect(isAllowedInboxMime(mime)).toBe(true);
    }
    expect(isAllowedInboxMime('application/zip')).toBe(false);
    expect(isAllowedInboxMime('application/x-msdownload')).toBe(false);
    expect(isAllowedInboxMime(undefined)).toBe(false);
  });

  it('neutralisiert Pfade und Steuerzeichen in Anzeigenamen', () => {
    expect(sanitizeInboxOriginalName('../ordner\\beleg\u0000.pdf')).toBe('.._ordner_beleg.pdf');
    expect(sanitizeInboxOriginalName(' \u0007 ')).toBe('anlage');
  });

  it('setzt die operative Entwurfsfrist auf exakt 24 Stunden', () => {
    const now = new Date('2026-09-01T12:00:00.000Z');
    expect(INBOX_BATCH_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(inboxBatchExpiresAt(now).toISOString()).toBe('2026-09-02T12:00:00.000Z');
  });
});
