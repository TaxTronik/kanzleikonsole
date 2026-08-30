import { describe, expect, it } from 'vitest';
import { anchoredPanelPlacement, revealPanelOption } from '../ui/anchored-panel';

const anchor = { left: 280, right: 600, top: 6, bottom: 50, width: 320, height: 44 };
const viewport = { left: 0, top: 0, width: 1280, height: 900 };

describe('Anchored panels', () => {
  it('uses relative coordinates and caps the preferred panel height', () => {
    expect(anchoredPanelPlacement(anchor, viewport, 448, 'start', 384)).toEqual({
      left: 0,
      top: 52,
      width: 448,
      maxHeight: 384,
    });
  });

  it('keeps a right-aligned notification panel within a narrow, low viewport', () => {
    const trigger = { left: 212, right: 256, top: 6, bottom: 50, width: 44, height: 44 };
    const result = anchoredPanelPlacement(
      trigger,
      { ...viewport, width: 320, height: 240 },
      384,
      'end',
    );
    expect(result.left + trigger.left).toBe(8);
    expect(result.width).toBe(304);
    expect(result.top! + trigger.top).toBe(58);
    expect(result.maxHeight + result.top! + trigger.top).toBe(232);
  });

  it('fits below a small input without constraining results to the input width', () => {
    const input = { left: 50, right: 92, top: 6, bottom: 50, width: 42, height: 44 };
    expect(anchoredPanelPlacement(input, { ...viewport, width: 320 }, 448, 'start')).toMatchObject({
      left: -42,
      width: 304,
    });
  });

  it('opens upwards when more space is available above the trigger', () => {
    const trigger = { ...anchor, top: 250, bottom: 294 };
    expect(anchoredPanelPlacement(trigger, { ...viewport, height: 320 }, 384, 'end')).toEqual({
      left: -64,
      bottom: 52,
      width: 384,
      maxHeight: 234,
    });
  });

  it('accounts for a panned visual viewport and an on-screen keyboard', () => {
    const result = anchoredPanelPlacement(
      anchor,
      { left: 240, top: 100, width: 320, height: 240 },
      448,
      'start',
    );
    expect(result.left + anchor.left).toBe(248);
    expect(result.top! + anchor.top).toBe(108);
    expect(result.maxHeight).toBe(224);
  });
});

function scrollPanel(scrollTop = 100) {
  return { scrollTop, clientHeight: 200, clientTop: 1, getBoundingClientRect: () => ({ top: 49 }) };
}

describe('Locally revealing the active search option', () => {
  it('does not scroll already visible options', () => {
    const panel = scrollPanel();
    revealPanelOption(panel, { getBoundingClientRect: () => ({ top: 80, bottom: 140 }) });
    expect(panel.scrollTop).toBe(100);
  });

  it('scrolls only the panel down to the last option', () => {
    const panel = scrollPanel();
    revealPanelOption(panel, { getBoundingClientRect: () => ({ top: 250, bottom: 300 }) });
    expect(panel.scrollTop).toBe(150);
  });

  it('scrolls back to a previous option above the visible range', () => {
    const panel = scrollPanel();
    revealPanelOption(panel, { getBoundingClientRect: () => ({ top: 10, bottom: 40 }) });
    expect(panel.scrollTop).toBe(60);
  });

  it('shows the beginning of a multiline option taller than the viewport', () => {
    const panel = scrollPanel();
    revealPanelOption(panel, { getBoundingClientRect: () => ({ top: 200, bottom: 500 }) });
    expect(panel.scrollTop).toBe(250);
  });
});
