import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const search = readFileSync(new URL('../global-search.tsx', import.meta.url), 'utf8');

describe('Global search keyboard and reading support', () => {
  it('reveals the active option in its own panel after keyboard navigation', () => {
    expect(search).toContain('ref={panelRef}');
    expect(search).toContain('querySelector<HTMLElement>(\'[aria-selected="true"]\')');
    expect(search).toContain('revealPanelOption(panelRef.current, option)');
    expect(search).not.toContain('.scrollIntoView(');
    expect(search).toContain('[activeIdx, items, showPanel, panelStyle]');
  });

  it('leaves text-editing Home/End and Enter alone when results are closed', () => {
    expect(search).toContain("e.key === 'Home' && showPanel && items.length > 0");
    expect(search).toContain("e.key === 'End' && showPanel && items.length > 0");
    expect(search).toContain("e.key === 'Enter' && showPanel");
  });

  it('closes on Tab and blur without preventing native focus navigation', () => {
    const tabBranch = search.slice(
      search.indexOf("e.key === 'Tab'"),
      search.indexOf('function navigate'),
    );
    expect(tabBranch).toContain('setOpen(false)');
    expect(tabBranch).not.toContain('preventDefault');
    expect(search).toContain('onBlur={() => setOpen(false)}');
    expect(search).toContain('onMouseDown={(event) => event.preventDefault()}');
  });

  it('fits its popup to the viewport and allows complete mode-specific text', () => {
    expect(search).toContain("useAnchoredPanel(showPanel, containerRef, 448, 'start', 384)");
    expect(search).toContain('style={panelStyle}');
    expect(search).toContain('useAccessibleDisplayEnabled()');
    expect(search).toContain("'font-medium break-words'");
    expect(search).toContain("'text-sm text-muted break-words'");
  });
});
