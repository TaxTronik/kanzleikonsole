'use client';
// =============================================================================
// Benachrichtigungsglocke der Kanzlei-Oberfläche. Zusammengesetzt nach
// Zuständigkeit (Review-Befund K-04):
//   notifications-bell-feed.ts      Zähler-Polling, Kurzliste, Zuwachs
//   notifications-bell-ack.ts       Quittieren (nur serverbestätigt, F-01)
//   notifications-bell-sound.ts     Ton-Einstellung
//   notifications-bell-alert.tsx    Hinweis „Neue Benachrichtigung“
//   notifications-bell-dropdown.tsx Dropdown (nichtmodaler Dialog)
//   notifications-bell-model.ts     reine Regeln (Zuwachs, Ziele, Zeiten)
// =============================================================================

import { useId, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import { useAccessibleDisplayEnabled } from './accessible-display';
import { useAnchoredPanel } from './ui/use-anchored-panel';
import { useNotificationFeed } from './notifications-bell-feed';
import { useNotificationAcknowledgement } from './notifications-bell-ack';
import { useNotificationSound } from './notifications-bell-sound';
import { NotificationAlert, useNotificationAlert } from './notifications-bell-alert';
import { NotificationsDropdown, useNotificationsDropdown } from './notifications-bell-dropdown';

interface Props {
  initialUnread: number;
  initialLatestUnreadAt: string | null;
}

export function NotificationsBell({ initialUnread, initialLatestUnreadAt }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const panelId = useId();
  const accessibleDisplay = useAccessibleDisplayEnabled();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { open, setOpen, focusTrigger, close } = useNotificationsDropdown({
    pathname,
    containerRef,
    triggerRef,
    panelRef,
  });
  const panelStyle = useAnchoredPanel(open, containerRef, 384, 'end');
  const alert = useNotificationAlert({ persistent: accessibleDisplay, open });
  const feed = useNotificationFeed({
    initialUnread,
    initialLatestUnreadAt,
    pathname,
    router,
    onAlert: alert.show,
  });
  const acknowledgement = useNotificationAcknowledgement(feed);
  const sound = useNotificationSound();
  const { unread } = feed;

  function toggle() {
    const next = !open;
    feed.touchNow();
    setOpen(next);
    if (next) feed.refreshRecent();
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className="relative p-2 text-muted hover:text-primary hover:bg-gray-100 rounded-md transition-colors"
        aria-label={unread > 0 ? `${unread} ungelesene Benachrichtigungen` : 'Benachrichtigungen'}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {alert.item && !open && (
        <NotificationAlert
          item={alert.item}
          accessibleDisplay={accessibleDisplay}
          interactionHandlers={alert.interactionHandlers}
          onOpen={() => {
            const item = alert.item!;
            alert.dismiss();
            void acknowledgement.markRead(item);
          }}
          onClose={() => {
            alert.dismiss();
            focusTrigger();
          }}
        />
      )}

      {open && (
        <NotificationsDropdown
          panelId={panelId}
          panelRef={panelRef}
          panelStyle={panelStyle}
          unread={unread}
          items={feed.items}
          now={feed.now}
          accessibleDisplay={accessibleDisplay}
          soundOn={sound.soundOn}
          onToggleSound={sound.toggleSound}
          onMarkAllRead={acknowledgement.markAllRead}
          onItemClick={(item) => void acknowledgement.markRead(item)}
          onClose={close}
        />
      )}
    </div>
  );
}
