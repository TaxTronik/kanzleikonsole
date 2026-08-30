interface Rectangle {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PanelPlacement {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/** Coordinates stay relative to the anchor, including inside filtered topbars. */
export function anchoredPanelPlacement(
  anchor: Rectangle,
  viewport: Viewport,
  preferredWidth: number,
  align: 'start' | 'end',
  preferredHeight = 480,
): PanelPlacement {
  const margin = 8;
  const gap = 8;
  const width = Math.min(preferredWidth, Math.max(0, viewport.width - margin * 2));
  const desiredLeft = align === 'end' ? anchor.right - width : anchor.left;
  const left = Math.max(
    viewport.left + margin,
    Math.min(desiredLeft, viewport.left + viewport.width - margin - width),
  );
  const belowTop = Math.max(anchor.bottom + gap, viewport.top + margin);
  const aboveBottom = Math.min(anchor.top - gap, viewport.top + viewport.height - margin);
  const below = Math.max(0, viewport.top + viewport.height - margin - belowTop);
  const above = Math.max(0, aboveBottom - viewport.top - margin);
  const placeAbove = below < Math.min(240, preferredHeight) && above > below;

  return {
    left: left - anchor.left,
    width,
    maxHeight: Math.min(preferredHeight, placeAbove ? above : below),
    ...(placeAbove ? { bottom: anchor.bottom - aboveBottom } : { top: belowTop - anchor.top }),
  };
}

/** Scroll only the result panel, never its document or surrounding main area. */
export function revealPanelOption(
  panel: {
    scrollTop: number;
    clientHeight: number;
    clientTop: number;
    getBoundingClientRect(): { top: number };
  },
  option: { getBoundingClientRect(): { top: number; bottom: number } },
) {
  const panelTop = panel.getBoundingClientRect().top + panel.clientTop;
  const panelBottom = panelTop + panel.clientHeight;
  const rect = option.getBoundingClientRect();
  if (rect.top < panelTop) panel.scrollTop += rect.top - panelTop;
  else if (rect.bottom > panelBottom) {
    // Oversized text entries start at their beginning instead of hiding the title.
    panel.scrollTop += Math.min(rect.bottom - panelBottom, rect.top - panelTop);
  }
}
