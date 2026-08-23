import { describe, expect, it, vi } from 'vitest';
import { lockInvoiceArchiveTx } from '../archive-lock';

describe('lockInvoiceArchiveTx', () => {
  it('verwendet für Archiv, Versand und Storno denselben rechnungsbezogenen Lock-Key', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0);
    await lockInvoiceArchiveTx({ $executeRaw: executeRaw } as never, 'invoice-42');

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw.mock.calls[0]?.[1]).toBe('invoice-archive:invoice-42');
  });
});
