import { useCallback, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react';

const holdMs = 500;
const moveTolerance = 10;
const clickGraceMs = 800;

interface Press {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface HeldClick {
  readonly pointerId: number;
  readonly anchor: HTMLElement;
  expiresAt: number;
}

export function useContextMenuTrigger(enabled: boolean, anchorSelector: string,
  onRequest: (anchor: HTMLElement) => boolean, keyboardTargetSelector = anchorSelector) {
  const anchorAt = (target: EventTarget | null, root: HTMLElement): HTMLElement | undefined => {
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLElement>(anchorSelector);
    return anchor && root.contains(anchor) ? anchor : undefined;
  };
  const press = useRef<Press | undefined>(undefined);
  const heldClick = useRef<HeldClick | undefined>(undefined);

  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = undefined;
  }, []);

  useLayoutEffect(() => {
    const pointerDown = (event: PointerEvent) => {
      cancelPress();
      // A new real press is independent of any compatibility click from the last hold.
      if (event.isPrimary) heldClick.current = undefined;
    };
    const pointerMove = (event: PointerEvent) => {
      const current = press.current;
      if (current?.pointerId === event.pointerId &&
        Math.hypot(event.clientX - current.x, event.clientY - current.y) > moveTolerance) cancelPress();
    };
    const pointerEnd = (event: PointerEvent) => {
      if (press.current?.pointerId === event.pointerId) cancelPress();
      const held = heldClick.current;
      if (held?.pointerId === event.pointerId) held.expiresAt = performance.now() + clickGraceMs;
    };
    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('pointermove', pointerMove, true);
    window.addEventListener('pointerup', pointerEnd, true);
    window.addEventListener('pointercancel', pointerEnd, true);
    window.addEventListener('blur', cancelPress);
    document.addEventListener('visibilitychange', cancelPress);
    return () => {
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('pointermove', pointerMove, true);
      window.removeEventListener('pointerup', pointerEnd, true);
      window.removeEventListener('pointercancel', pointerEnd, true);
      window.removeEventListener('blur', cancelPress);
      document.removeEventListener('visibilitychange', cancelPress);
      cancelPress();
      heldClick.current = undefined;
    };
  }, [cancelPress]);

  useLayoutEffect(() => {
    if (!enabled) cancelPress();
  }, [enabled, cancelPress]);

  const request = (anchor: HTMLElement): boolean => enabled && anchor.isConnected && onRequest(anchor);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || !event.isPrimary || event.button !== 0 ||
      (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    const anchor = anchorAt(event.target, event.currentTarget);
    if (!anchor) return;
    const { pointerId, clientX: x, clientY: y, currentTarget } = event;
    press.current = {
      pointerId, x, y,
      timer: setTimeout(() => {
        press.current = undefined;
        if (document.visibilityState === 'visible' && currentTarget.contains(anchor) && request(anchor)) {
          heldClick.current = { pointerId, anchor, expiresAt: performance.now() + holdMs + clickGraceMs };
        }
      }, holdMs),
    };
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = enabled && anchorAt(event.target, event.currentTarget);
    if (!anchor) return;
    event.preventDefault();
    // The touch hold owns the gesture. A browser callout must not open it again.
    const native = event.nativeEvent;
    if (press.current || (heldClick.current && heldClick.current.expiresAt >= performance.now()) ||
      (typeof PointerEvent !== 'undefined' && native instanceof PointerEvent && native.pointerType && native.pointerType !== 'mouse')) return;
    if (event.button === 2 || event.ctrlKey) request(anchor);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat ||
      (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return;
    const anchor = anchorAt(event.target, event.currentTarget);
    if (anchor && event.target instanceof HTMLElement && event.target.matches(keyboardTargetSelector) &&
      request(anchor)) event.preventDefault();
  };

  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const held = heldClick.current;
    if (!held || event.detail === 0 || performance.now() > held.expiresAt ||
      anchorAt(event.target, event.currentTarget) !== held.anchor) return;
    heldClick.current = undefined;
    event.preventDefault();
    event.stopPropagation();
  };

  return { onPointerDown, onContextMenu, onKeyDown, onClickCapture, onScroll: cancelPress };
}
