import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleSidebarInitialFocus } from '../mobile-sidebar-toggle';

function fixture(initialVisibility = 'visible') {
  const sidebar = new EventTarget() as HTMLElement;
  const documentStub: { activeElement: HTMLElement | null } = { activeElement: null };
  const target = {
    focus: vi.fn(() => {
      documentStub.activeElement = target;
    }),
  } as unknown as HTMLElement;
  let visibility = initialVisibility;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('window', {
    getComputedStyle: () => ({ visibility }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (frame: number) => frames.delete(frame),
  });
  const stop = scheduleSidebarInitialFocus(sidebar, () => target);
  return {
    target,
    frames,
    documentStub,
    stop,
    show() {
      visibility = 'visible';
    },
    nextFrame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
    transition(propertyName: string, type = 'transitionend') {
      sidebar.dispatchEvent(Object.assign(new Event(type), { propertyName }));
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('initialer Fokus der mobilen Sidebar', () => {
  it('fokussiert eine sichtbare Sidebar im ersten Frame', () => {
    const test = fixture();
    expect(test.target.focus).not.toHaveBeenCalled();
    test.nextFrame();
    expect(test.documentStub.activeElement).toBe(test.target);
    expect(test.frames.size).toBe(0);
  });

  it('wartet nach einem noch versteckten Frame gezielt auf visibility', () => {
    const test = fixture('hidden');
    test.nextFrame();
    expect(test.target.focus).not.toHaveBeenCalled();
    test.transition('visibility');
    expect(test.target.focus).not.toHaveBeenCalled();
    test.show();
    test.transition('transform');
    expect(test.target.focus).not.toHaveBeenCalled();
    test.transition('visibility');
    expect(test.documentStub.activeElement).toBe(test.target);
  });

  it('berücksichtigt auch abgebrochene Sichtbarkeitsanimationen', () => {
    const test = fixture('hidden');
    test.nextFrame();
    test.show();
    test.transition('visibility', 'transitioncancel');
    expect(test.documentStub.activeElement).toBe(test.target);
  });

  it('nimmt nach erfolgreichem Initialfokus keinen späteren Benutzerfokus weg', () => {
    const test = fixture();
    test.nextFrame();
    test.documentStub.activeElement = null;
    test.transition('visibility');
    test.transition('visibility', 'transitioncancel');
    expect(test.target.focus).toHaveBeenCalledTimes(1);
    expect(test.documentStub.activeElement).toBeNull();
  });

  it('räumt beim Schließen vor dem ersten Frame auf', () => {
    const test = fixture();
    const queuedFrame = test.frames.values().next().value!;
    test.stop();
    test.stop();
    expect(test.frames.size).toBe(0);
    queuedFrame(0);
    test.transition('visibility');
    expect(test.target.focus).not.toHaveBeenCalled();
  });

  it('fokussiert nach Schließen während der Animation nicht mehr', () => {
    const test = fixture('hidden');
    test.nextFrame();
    test.stop();
    test.show();
    test.transition('visibility');
    test.transition('visibility', 'transitioncancel');
    expect(test.target.focus).not.toHaveBeenCalled();
  });
});
