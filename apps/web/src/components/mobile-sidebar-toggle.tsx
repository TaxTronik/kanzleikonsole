'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { AppPortal } from '@/components/ui/modal';

/** A reduced-motion override can turn visibility: 0s into a short transition.
 *  The first frame may therefore still be hidden and reject focus. Retry only
 *  for this sidebar's visibility change, and stop as soon as focus succeeds. */
export function scheduleSidebarInitialFocus(
  sidebar: HTMLElement,
  getTarget: () => HTMLElement | null,
): () => void {
  let active = true;
  let frame: number | null = null;

  const stop = () => {
    if (!active) return;
    active = false;
    if (frame !== null) window.cancelAnimationFrame(frame);
    sidebar.removeEventListener('transitionend', onVisibilityChange);
    sidebar.removeEventListener('transitioncancel', onVisibilityChange);
  };
  const focus = () => {
    if (!active || window.getComputedStyle(sidebar).visibility !== 'visible') return;
    const target = getTarget();
    target?.focus();
    if (target && document.activeElement === target) stop();
  };
  const onVisibilityChange = (event: Event) => {
    if (event.target === sidebar && (event as TransitionEvent).propertyName === 'visibility') {
      focus();
    }
  };

  sidebar.addEventListener('transitionend', onVisibilityChange);
  sidebar.addEventListener('transitioncancel', onVisibilityChange);
  frame = window.requestAnimationFrame(() => {
    frame = null;
    focus();
  });
  return stop;
}

/**
 * Hamburger-Toggle für die Sidebar auf <md.
 *
 * Steuert die Sichtbarkeit der `<aside>` über Body-Class `sidebar-open`.
 * CSS in globals.css übernimmt das Verstecken/Anzeigen via media-query.
 */
const MOBILE_QUERY = '(max-width: 767px)';
function subscribeViewport(onChange: () => void) {
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
function readMobileViewport() {
  return window.matchMedia(MOBILE_QUERY).matches;
}
// The sidebar belongs to the persistent layout and is available after hydration.
const subscribeSidebar = () => () => {};
const readSidebar = () => document.getElementById('app-sidebar');

export function MobileSidebarToggle() {
  const [open, setOpen] = useState(false);
  const isMobile = useSyncExternalStore(subscribeViewport, readMobileViewport, () => false);
  const sidebar = useSyncExternalStore(subscribeSidebar, readSidebar, () => null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const pathname = usePathname();

  const [previousLocation, setPreviousLocation] = useState({ pathname, isMobile });
  if (previousLocation.pathname !== pathname || previousLocation.isMobile !== isMobile) {
    setPreviousLocation({ pathname, isMobile });
    if (previousLocation.pathname !== pathname || !isMobile) setOpen(false);
  }

  useEffect(() => {
    const main = document.getElementById('main-content');
    if (!sidebar) return;

    if (isMobile && !open) {
      sidebar.setAttribute('inert', '');
      sidebar.setAttribute('aria-hidden', 'true');
    } else {
      sidebar.removeAttribute('inert');
      sidebar.removeAttribute('aria-hidden');
    }

    if (isMobile && open) {
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
      main?.setAttribute('inert', '');
      main?.setAttribute('aria-hidden', 'true');
      document.body.classList.add('sidebar-open');
      document.body.classList.add('overflow-hidden');
    } else {
      sidebar.removeAttribute('role');
      sidebar.removeAttribute('aria-modal');
      main?.removeAttribute('inert');
      main?.removeAttribute('aria-hidden');
      document.body.classList.remove('sidebar-open');
      document.body.classList.remove('overflow-hidden');
    }

    return () => {
      sidebar.removeAttribute('inert');
      sidebar.removeAttribute('aria-hidden');
      sidebar.removeAttribute('role');
      sidebar.removeAttribute('aria-modal');
      main?.removeAttribute('inert');
      main?.removeAttribute('aria-hidden');
      document.body.classList.remove('sidebar-open');
      document.body.classList.remove('overflow-hidden');
    };
  }, [isMobile, open, sidebar]);

  useEffect(() => {
    if (!isMobile || !sidebar) {
      wasOpenRef.current = false;
      return;
    }

    if (!open) {
      if (wasOpenRef.current) triggerRef.current?.focus();
      wasOpenRef.current = false;
      return;
    }

    wasOpenRef.current = true;
    const stopInitialFocus = scheduleSidebarInitialFocus(sidebar, () => closeRef.current);
    const focusables = () =>
      Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),summary,[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusables();
      if (elements.length === 0) {
        event.preventDefault();
        closeRef.current?.focus();
        return;
      }
      const first = elements[0]!;
      const last = elements[elements.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      stopInitialFocus();
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMobile, open, sidebar]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="md:hidden icon-action -ml-2"
        aria-label={open ? 'Menü schließen' : 'Menü öffnen'}
        aria-controls="app-sidebar"
        aria-expanded={isMobile && open}
      >
        {open ? (
          <X className="h-5 w-5" aria-hidden="true" />
        ) : (
          <Menu className="h-5 w-5" aria-hidden="true" />
        )}
      </button>

      {isMobile && open ? (
        <AppPortal>
          <div
            className="fixed inset-0 z-30 bg-black/40"
            aria-hidden="true"
            onMouseDown={() => setOpen(false)}
          />
        </AppPortal>
      ) : null}

      {isMobile && open && sidebar ? (
        <AppPortal target={sidebar}>
          <button
            ref={closeRef}
            type="button"
            onClick={() => setOpen(false)}
            className="icon-action absolute right-3 top-3 z-50"
            aria-label="Menü schließen"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </AppPortal>
      ) : null}
    </>
  );
}
