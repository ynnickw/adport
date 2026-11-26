'use client';

import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

type Placement = {
  align?: 'start' | 'end';
  minWidth?: number;
  maxWidth?: number;
  heightLimit?: number;
};

export function useAnchoredLayer(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  { align = 'start', minWidth = 220, maxWidth = 360, heightLimit = 320 }: Placement = {},
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open) { setPosition(undefined); return; }
    function place() {
      const anchor = trigger.current;
      const surface = panel.current;
      if (!anchor || !surface) return;
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16;
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
      const width = Math.max(0, Math.min(Math.max(minWidth, rect.width), maxWidth, rightEdge - leftEdge));
      const left = Math.max(leftEdge, Math.min(align === 'end' ? rect.right - width : rect.left, rightEdge - width));
      const below = Math.max(0, bottomEdge - rect.bottom - 6);
      const above = Math.max(0, rect.top - topEdge - 6);
      const height = Math.min(heightLimit, surface.scrollHeight);
      // Allow the panel to scroll and flip near the bottom of the viewport.
      const flip = below < Math.max(96, height) && above > below;
      const maxHeight = Math.min(heightLimit, flip ? above : below);
      const top = Math.max(topEdge, rect.bottom + 6);
      const bottom = window.innerHeight - Math.min(rect.top - 6, bottomEdge);
      const next: CSSProperties = { width, left, maxHeight, ...(flip ? { bottom } : { top }) };
      setPosition(current => current?.width === width && current?.left === left && current?.maxHeight === maxHeight &&
        current?.top === next.top && current?.bottom === next.bottom ? current : next);
    }
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    if (trigger.current) observer?.observe(trigger.current);
    if (panel.current) observer?.observe(panel.current);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { capture: true, passive: true });
    return () => {
      observer?.disconnect();
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, trigger, panel, align, minWidth, maxWidth, heightLimit]);
  return position ?? { visibility: 'hidden' };
}
