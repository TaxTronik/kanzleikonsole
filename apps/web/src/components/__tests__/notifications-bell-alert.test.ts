import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bell = readFileSync(new URL('../notifications-bell.tsx', import.meta.url), 'utf8');

describe('NotificationsBell Alert', () => {
  it('zeigt neue handlungsrelevante Einträge als sichtbaren, zugänglichen Hinweis an', () => {
    expect(bell).toContain('showNotificationAlert(newestUnread)');
    expect(bell).toContain('role="status"');
    expect(bell).toContain('aria-live="polite"');
    expect(bell).toContain('Neue Benachrichtigung');
    expect(bell).toContain('if (grew) onUnreadGrew();');
  });

  it('quittiert einen auf der sichtbaren Zielseite bereits dargestellten Abschluss', () => {
    expect(bell).toContain('shouldAcknowledgeCompletionOnCurrentPage({');
    expect(bell).toContain('markNotificationReadByIdAction({ id: newestUnread.id })');
    expect(bell).toContain('router.refresh();');
  });
});
