import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleNotificationAlertDismiss } from '../ui/notification-alert-timing';

describe('Notification reading time', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the original eight-second timeout in the regular view', () => {
    const dismiss = vi.fn();
    scheduleNotificationAlertDismiss({ persistent: false, interacting: false, dismiss });
    vi.advanceTimersByTime(7999);
    expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('never schedules an automatic dismissal in personal display mode', () => {
    const dismiss = vi.fn();
    scheduleNotificationAlertDismiss({ persistent: true, interacting: false, dismiss });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(dismiss).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses reading while the pointer, keyboard focus or feed is active', () => {
    const dismiss = vi.fn();
    scheduleNotificationAlertDismiss({ persistent: false, interacting: true, dismiss });
    vi.advanceTimersByTime(60_000);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('cleans up an already running timer when the mode becomes active', () => {
    const dismiss = vi.fn();
    const cleanup = scheduleNotificationAlertDismiss({
      persistent: false,
      interacting: false,
      dismiss,
    });
    vi.advanceTimersByTime(4000);
    cleanup();
    scheduleNotificationAlertDismiss({ persistent: true, interacting: false, dismiss });
    vi.advanceTimersByTime(60_000);
    expect(dismiss).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the old timeout when the visible alert changes or unmounts', () => {
    const dismiss = vi.fn();
    const cleanup = scheduleNotificationAlertDismiss({
      persistent: false,
      interacting: false,
      dismiss,
    });
    cleanup();
    vi.advanceTimersByTime(8000);
    expect(dismiss).not.toHaveBeenCalled();
  });
});
