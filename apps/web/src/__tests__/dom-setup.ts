// Setup aller Web-Testdateien (vitest.config.ts, setupFiles). Eine DOM gibt es
// nur in Dateien mit dem Kopfkommentar `// @vitest-environment jsdom` (B-08,
// Welle 15). Dort baut Testing Library nach jedem Test den gerenderten Baum
// ab; die übrigen Testdateien laufen in Node und laden Testing Library nicht.
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });

  // jsdom misst kein Layout und kennt ResizeObserver nicht; Popover-Bibliotheken
  // (floating-ui) beobachten damit nur Größenänderungen. Ohne Layout gibt es
  // keine, ein stummer Beobachter ist deshalb gleichwertig.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
