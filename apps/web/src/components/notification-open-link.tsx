'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useRef, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { markNotificationReadByIdAction } from '@/app/staff/(protected)/notifications/actions';
import { emitNotificationsChanged } from '@/lib/live-events';

export function NotificationOpenLink({
  id,
  href,
  unread,
  className,
  children,
}: {
  id: string;
  href: string;
  unread: boolean;
  className?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const pendingRef = useRef(false);
  const [isPending, startTransition] = useTransition();

  async function markRead(): Promise<void> {
    if (!unread || pendingRef.current) return;
    pendingRef.current = true;
    try {
      const result = await markNotificationReadByIdAction({ id });
      if (result.ok) emitNotificationsChanged();
    } finally {
      pendingRef.current = false;
    }
  }

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!unread) return;

    // Modifier-Klicks behalten das Browser-Verhalten (neuer Tab), markieren
    // aber dieselbe Notification im Ausgangs-Tab ebenfalls als gelesen.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      void markRead();
      return;
    }

    event.preventDefault();
    startTransition(async () => {
      await markRead();
      if (href === pathname) router.refresh();
      else router.push(href);
    });
  }

  return (
    <Link
      href={href}
      onClick={handleClick}
      className={className}
      aria-busy={isPending || undefined}
    >
      {children}
    </Link>
  );
}
