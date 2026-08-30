'use client';

import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { anchoredPanelPlacement } from './anchored-panel';

/** Re-measure on zoom, virtual keyboards, scrolling and changes to the header. */
export function useAnchoredPanel(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  width: number,
  align: 'start' | 'end',
  maxHeight = 480,
): CSSProperties | undefined {
  const [placement, setPlacement] = useState<CSSProperties>();

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    function update() {
      if (!anchor) return;
      const viewport = window.visualViewport;
      const next = anchoredPanelPlacement(
        anchor.getBoundingClientRect(),
        {
          left: viewport?.offsetLeft ?? 0,
          top: viewport?.offsetTop ?? 0,
          width: viewport?.width ?? document.documentElement.clientWidth,
          height: viewport?.height ?? window.innerHeight,
        },
        width,
        align,
        maxHeight,
      );
      setPlacement((current) =>
        current?.left === next.left &&
        current.width === next.width &&
        current.maxHeight === next.maxHeight &&
        current.top === next.top &&
        current.bottom === next.bottom
          ? current
          : next,
      );
    }
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [open, anchorRef, width, align, maxHeight]);

  return placement;
}
