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

  it('bietet einen benannten nichtmodalen Dialog mit echtem Schließen-Button', () => {
    expect(bell).toContain('aria-haspopup="dialog"');
    expect(bell).toContain('role="dialog"');
    expect(bell).toContain('aria-labelledby={`${panelId}-heading`}');
    expect(bell).toContain('aria-label="Benachrichtigungen schließen"');
    expect(bell).not.toContain('role="menu"');
    expect(bell).not.toContain('aria-modal="true"');
    expect(bell).toContain('panelRef.current?.focus({ preventScroll: true })');
    expect(bell).toContain('triggerRef.current?.focus({ preventScroll: true })');
    expect(bell).toContain(
      "event.key === 'Escape' && containerRef.current?.contains(event.target as Node)",
    );
    expect(bell).toContain('event.currentTarget.contains(event.relatedTarget)');
  });

  it('hält den ganzen Feed samt Kopf und Fuß scrollbar im sichtbaren Bereich', () => {
    expect(bell).toContain("useAnchoredPanel(open, containerRef, 384, 'end')");
    expect(bell).toContain('style={panelStyle}');
    expect(bell).toContain('overflow-y-auto overscroll-contain');
    expect(bell).not.toContain('max-h-96');
  });

  it('zeigt im Profilmodus ungekürzte Inhalte und lesbare semantische Zeiten', () => {
    expect(bell).toContain('useAccessibleDisplayEnabled()');
    expect(bell).toContain("accessibleDisplay ? 'break-words' : 'truncate'");
    expect(bell).toContain("'text-sm text-muted whitespace-pre-wrap break-words'");
    expect(bell).toContain('dateTime={n.createdAt}');
    expect(bell).toContain("accessibleDisplay ? 'text-sm' : 'text-xs'");
    expect(bell).toContain('<span className="sr-only">Ungelesen. </span>');
  });

  it('koppelt die Lesefrist an Profilmodus und Interaktion, nicht an Sound oder Fachlogik', () => {
    expect(bell).toContain('persistent: accessibleDisplay');
    expect(bell).toContain('interacting: alertHovered || alertFocused || open');
    expect(bell).toContain('return scheduleNotificationAlertDismiss(');
    expect(bell).toContain('[alertItem, accessibleDisplay, alertHovered, alertFocused, open]');
    expect(bell).toContain('alertItem && !open && (');
  });
});
