// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, type ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Echte Radix-Menüs; Content wird nur umhüllt, um die übergebenen Props
// (Randabstand, Handler) festzuhalten.
const contentProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@radix-ui/react-dropdown-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@radix-ui/react-dropdown-menu')>();
  const Content = forwardRef<HTMLDivElement, ComponentProps<typeof actual.Content>>(
    function RecordedContent(props, ref) {
      contentProps.push(props as Record<string, unknown>);
      return <actual.Content ref={ref} {...props} />;
    },
  );
  return { ...actual, Content };
});

import { createActionMenuKeyboardExit } from '../use-action-menu';
import { UserMenu } from '../../user-menu';
import { OverflowItem, OverflowMenu } from '../../overflow-menu';

function fixture() {
  const order: string[] = [];
  const focus = vi.fn(() => order.push('focus-trigger'));
  const trigger = { isConnected: true, focus };
  const close = vi.fn(() => order.push('close'));
  const keyboardExit = createActionMenuKeyboardExit();
  const event = {
    key: 'Tab',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    stopPropagation: vi.fn(() => order.push('stop-propagation')),
    preventDefault: vi.fn(),
  };
  const handlers = {
    onKeyDownCapture: (tabEvent: typeof event) =>
      keyboardExit.onKeyDownCapture(tabEvent, trigger, close),
    onCloseAutoFocus: keyboardExit.onCloseAutoFocus,
  };
  return { order, trigger, close, handlers, event };
}

describe('nichtmodale Aktionsmenüs: nativer Tab-Ausstieg', () => {
  it.each([false, true])(
    'lässt Tab/Shift+Tab (%s) nativ ab dem Auslöser weiterlaufen',
    (shiftKey) => {
      const { order, trigger, close, handlers, event } = fixture();
      event.shiftKey = shiftKey;
      handlers.onKeyDownCapture(event);
      expect(order).toEqual(['stop-propagation', 'focus-trigger', 'close']);
      expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(close).toHaveBeenCalledOnce();
      expect(event.preventDefault).not.toHaveBeenCalled();
    },
  );

  it('unterbindet nur die auf diesen Tab-Ausstieg folgende asynchrone Fokus-Rückgabe', () => {
    const { handlers, event } = fixture();
    const autofocus = { preventDefault: vi.fn() };
    handlers.onKeyDownCapture(event);
    handlers.onCloseAutoFocus(autofocus);
    expect(autofocus.preventDefault).toHaveBeenCalledOnce();
    handlers.onCloseAutoFocus(autofocus);
    expect(autofocus.preventDefault).toHaveBeenCalledOnce();
  });

  it.each(['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '])(
    'belässt %s und reguläre Fokus-Rückgabe bei Radix',
    (key) => {
      const { trigger, close, handlers, event } = fixture();
      event.key = key;
      handlers.onKeyDownCapture(event);
      const autofocus = { preventDefault: vi.fn() };
      handlers.onCloseAutoFocus(autofocus);
      expect(event.stopPropagation).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(trigger.focus).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(autofocus.preventDefault).not.toHaveBeenCalled();
    },
  );

  it.each(['altKey', 'ctrlKey', 'metaKey', 'defaultPrevented'] as const)(
    'fängt bei %s keine Browser-/bereits behandelten Tastenkombinationen ab',
    (property) => {
      const { order, handlers, event } = fixture();
      event[property] = true;
      handlers.onKeyDownCapture(event);
      expect(order).toEqual([]);
    },
  );

  it('erzwingt keinen Fokuswechsel zu einem bereits entfernten Auslöser', () => {
    const { order, trigger, handlers, event } = fixture();
    trigger.isConnected = false;
    handlers.onKeyDownCapture(event);
    expect(order).toEqual([]);
  });

  it('behandelt einen noch nicht gemounteten Auslöser ohne Fehler', () => {
    const { event } = fixture();
    const close = vi.fn();
    createActionMenuKeyboardExit().onKeyDownCapture(event, null, close);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

// Verdrahtung in UserMenu und OverflowMenu als Verhalten (B-08, Welle 15):
// nichtmodal, Tab verlässt das Menü nativ ab dem Auslöser, Escape gibt den
// Fokus zurück, Randabstand 8 px zum Viewport.
const menus = {
  'user-menu': () => (
    <UserMenu
      name="Erika Muster"
      email="erika@kanzlei.example"
      profileHref="/staff/profile"
      profileLabel="Benutzerprofil"
      logoutAction="/api/staff/force-logout"
    />
  ),
  'overflow-menu': () => (
    <OverflowMenu>
      <OverflowItem>Bearbeiten</OverflowItem>
      <OverflowItem danger>Löschen</OverflowItem>
    </OverflowMenu>
  ),
};
const triggers = { 'user-menu': 'Konto-Menü öffnen', 'overflow-menu': 'Weitere Aktionen' };

beforeEach(() => {
  contentProps.length = 0;
});

function openMenu(component: keyof typeof menus) {
  render(
    <>
      <button type="button">Vorher</button>
      {menus[component]()}
      <button type="button">Danach</button>
    </>,
  );
  const trigger = screen.getByRole('button', { name: triggers[component] });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return { trigger, menu: screen.getByRole('menu') };
}

describe.each(Object.keys(menus) as (keyof typeof menus)[])('%s', (component) => {
  it('öffnet nichtmodal: der Hintergrund bleibt zugänglich', () => {
    const { trigger } = openMenu(component);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.style.pointerEvents).not.toBe('none');
    const outside = screen.getByRole('button', { name: 'Danach' });
    expect(outside.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('verlässt das Menü mit Tab nativ ab dem Auslöser, ohne den Fokus zurückzuholen', async () => {
    const { trigger, menu } = openMenu(component);
    const item = screen.getAllByRole('menuitem')[0]!;
    item.focus();

    // Kein preventDefault: der Browser setzt die Tab-Navigation ab dem Auslöser fort.
    expect(fireEvent.keyDown(item, { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(menu.isConnected).toBe(false));

    // Das native Tabziel behält den Fokus, Radix gibt ihn nicht asynchron zurück.
    const next = screen.getByRole('button', { name: 'Danach' });
    next.focus();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(next);
  });

  it('schließt mit Escape und gibt den Fokus an den Auslöser zurück', async () => {
    const { trigger, menu } = openMenu(component);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(menu.isConnected).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('hält 8 px Abstand zum Viewport-Rand', () => {
    openMenu(component);
    expect(contentProps.at(-1)).toMatchObject({ collisionPadding: 8 });
  });
});
