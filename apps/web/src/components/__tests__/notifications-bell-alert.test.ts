import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bell = readFileSync(new URL('../notifications-bell.tsx', import.meta.url), 'utf8');

describe('NotificationsBell Alert', () => {
  it('zeigt neue Einträge als sichtbaren, zugänglichen Hinweis an', () => {
    expect(bell).toContain('showNotificationAlert(newestUnread)');
    expect(bell).toContain('role="status"');
    expect(bell).toContain('aria-live="polite"');
    expect(bell).toContain('Neue Benachrichtigung');
    expect(bell).toContain('if (grew) onUnreadGrew();');
  });
});
