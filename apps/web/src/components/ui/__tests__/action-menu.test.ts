import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createActionMenuKeyboardExit } from '../use-action-menu';

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

  for (const component of ['user-menu', 'overflow-menu']) {
    it(`verdrahtet ${component} ohne modale Hintergrundsperre, mit Tab-Ausstieg und Randabstand`, () => {
      const source = readFileSync(new URL(`../../${component}.tsx`, import.meta.url), 'utf8');
      expect(source).toContain('modal={false}');
      expect(source).toContain('open={open}');
      expect(source).toContain('onOpenChange={onOpenChange}');
      expect(source).toContain('ref={triggerRef}');
      expect(source).toContain('onKeyDownCapture={onKeyDownCapture}');
      expect(source).toContain('onCloseAutoFocus={onCloseAutoFocus}');
      expect(source).toContain('collisionPadding={8}');
    });
  }
});
