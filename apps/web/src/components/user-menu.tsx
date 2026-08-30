'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import Link from 'next/link';
import { useRef } from 'react';
import { LogOut, UserRound } from 'lucide-react';
import { useActionMenu } from './ui/use-action-menu';

interface Props {
  name: string | null;
  email: string;
  /** Ziel des Profil-Links (Staff: /staff/profile, Portal: /portal/settings). */
  profileHref: string;
  profileLabel: string;
  /** Form-Action für den Logout (Staff: /api/staff/force-logout, Portal: /api/portal/logout). */
  logoutAction: string;
}

/** Initialen aus dem Namen (erster + letzter Wort-Anfang), Fallback '?'. */
function initialsOf(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]![0]! : '';
  return (first + last).toUpperCase();
}

/**
 * Konto-Menü oben rechts in der Topbar: Avatar-Button öffnet ein Dropdown
 * mit Konto-Kopf (Name/E-Mail), Profil-Link und Abmelden. Ersetzt den
 * früheren Sidebar-Footer (User-Chip + Profil-Link) — dort bleibt nur
 * noch der Abmelden-Button.
 *
 * Nichtmodal: Hintergrund bleibt zugänglich. Radix übernimmt role=menu/menuitem,
 * Pfeiltasten und Escape mit Fokus-Rückgabe. Tab/Shift+Tab verlassen das Menü
 * entlang der nativen Tabreihenfolge; ein Außenklick behält sein eigenes Ziel.
 * Tastatur-Highlight läuft über [data-highlighted] (siehe globals.css).
 */
export function UserMenu({ name, email, profileHref, profileLabel, logoutAction }: Props) {
  const initials = initialsOf(name);
  const logoutFormRef = useRef<HTMLFormElement>(null);
  const { open, onOpenChange, triggerRef, onKeyDownCapture, onCloseAutoFocus } = useActionMenu();

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
        <DropdownMenu.Trigger asChild>
          <button ref={triggerRef} type="button" className="avatar-btn" title="Konto">
            <span className="avatar" aria-hidden>
              {initials}
            </span>
            <span className="sr-only">Konto-Menü öffnen</span>
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="user-dropdown"
            align="end"
            sideOffset={8}
            collisionPadding={8}
            onKeyDownCapture={onKeyDownCapture}
            onCloseAutoFocus={onCloseAutoFocus}
          >
            {/* Konto-Kopf: rein informativ, kein Menüeintrag (nicht fokussierbar) */}
            <div className="ud-head">
              <span className="avatar" aria-hidden>
                {initials}
              </span>
              <div className="min-w-0">
                <div className="uname truncate">{name ?? '—'}</div>
                <div className="umail truncate">{email}</div>
              </div>
            </div>
            <DropdownMenu.Separator className="ud-sep" />
            <DropdownMenu.Item asChild>
              <Link href={profileHref} className="ud-item">
                <UserRound className="h-4 w-4" />
                {profileLabel}
              </Link>
            </DropdownMenu.Item>
            <DropdownMenu.Item asChild onSelect={() => logoutFormRef.current?.requestSubmit()}>
              <button type="button" className="ud-item ud-item-danger">
                <LogOut className="h-4 w-4" />
                Abmelden
              </button>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {/* Das Formular bleibt beim Schließen des Portals gemountet. Dadurch
          kann Radix den auslösenden Menüeintrag nicht vor dem POST entfernen. */}
      <form ref={logoutFormRef} action={logoutAction} method="post" className="hidden" />
    </>
  );
}
