'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useActionMenu } from './ui/use-action-menu';

// =============================================================================
// OverflowMenu — „⋯"-Aktionsmenü für Listenzeilen (z. B. Routen-Karten).
// Sammelt Sekundär-/Gefahren-Aktionen, damit Zeilen nur noch Primäraktionen
// sichtbar tragen. Nichtmodal; Radix übernimmt Rolle, Pfeiltasten und Escape
// mit Fokus-Rückgabe. Tab/Shift+Tab verlassen es in der nativen Tabreihenfolge.
// Styling über die user-dropdown/ud-item-Klassen aus globals.css.
// =============================================================================

export function OverflowMenu({
  label = 'Weitere Aktionen',
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const { open, onOpenChange, triggerRef, onKeyDownCapture, onCloseAutoFocus } = useActionMenu();
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="icon-action"
          title={label}
          aria-label={label}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="user-dropdown"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          onKeyDownCapture={onKeyDownCapture}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function OverflowItem({
  onSelect,
  disabled,
  danger,
  icon,
  children,
}: {
  onSelect?: () => void;
  disabled?: boolean;
  /** Destruktive Aktion (rot). */
  danger?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Item asChild disabled={disabled}>
      <button
        type="button"
        className={`ud-item${danger ? ' ud-item-danger' : ''}`}
        onClick={onSelect}
      >
        {icon}
        {children}
      </button>
    </DropdownMenu.Item>
  );
}

export function OverflowSeparator() {
  return <DropdownMenu.Separator className="ud-sep" />;
}
