import { describe, expect, it, vi } from 'vitest';
import { myDayCompletionError } from '../my-day-completion';

describe('MyDayToggle optimistic completion', () => {
  it('meldet den Action-Fehler fuer den UI-Rollback', async () => {
    const action = vi.fn().mockResolvedValue({ ok: false, error: 'Keine Berechtigung.' });
    await expect(myDayCompletionError('item-1', action)).resolves.toBe('Keine Berechtigung.');
    expect(action).toHaveBeenCalledWith({ id: 'item-1', done: true });
  });

  it('bestaetigt nur ein persistiertes ok-Ergebnis', async () => {
    await expect(
      myDayCompletionError('item-1', vi.fn().mockResolvedValue({ ok: true })),
    ).resolves.toBeNull();
  });

  it('rollt auch bei einer geworfenen Transport-Exception zurueck', async () => {
    await expect(
      myDayCompletionError('item-1', vi.fn().mockRejectedValue(new Error('network unavailable'))),
    ).resolves.toMatch(/erneut versuchen/);
  });
});
