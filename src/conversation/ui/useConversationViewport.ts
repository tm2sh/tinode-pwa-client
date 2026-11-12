import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

// Move the composer above the native keyboard; the edge shadow stays on the screen.
export function useConversationViewport(root: RefObject<HTMLElement | null>, header: RefObject<HTMLElement | null>,
  footer: RefObject<HTMLElement | null>, active = true): void {
  useLayoutEffect(() => {
    const screen = root.current, top = header.current, bottom = footer.current;
    if (!active || !screen || !top || !bottom) return;
    const viewport = window.visualViewport, html = document.documentElement;
    const previous = html.getAttribute('data-conversation-active');
    html.dataset.conversationActive = 'true';
    let frame = 0, keyboardOpen = false;
    const measure = () => {
      frame = 0;
      if (viewport && Math.abs(viewport.scale - 1) > .01) return;
      const bounds = screen.getBoundingClientRect(), active = document.activeElement;
      const editing = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && screen.contains(active);
      // iOS can report a panned visualViewport.offsetTop while showing its keyboard.
      // The fixed screen stays at the origin; only its visible height is relevant.
      const availableBottom = bounds.top + (viewport?.height ?? window.innerHeight);
      const offset = (editing || keyboardOpen) && bounds.bottom - availableBottom > 120 ? Math.max(0, bounds.bottom - availableBottom) : 0;
      keyboardOpen = offset > 0;
      screen.style.setProperty('--conversation-keyboard-offset', offset + 'px');
      screen.dataset.keyboardOpen = String(offset > 0);
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      const headerBottom = top.getBoundingClientRect().bottom;
      screen.style.setProperty('--conversation-composer-room', Math.max(0, bounds.bottom - offset - headerBottom - 8) + 'px');
      screen.style.setProperty('--conversation-top-inset', Math.max(0, headerBottom - bounds.top + 20) + 'px');
      screen.style.setProperty('--conversation-bottom-inset', Math.max(0, bounds.bottom - bottom.getBoundingClientRect().top + 20) + 'px');
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const focus = (event: PointerEvent) => {
      const field = event.target;
      if ((navigator as Navigator & { standalone?: boolean }).standalone !== true ||
        !(field instanceof HTMLInputElement) || field.disabled || document.activeElement === field || !event.isPrimary || event.button !== 0) return;
      event.preventDefault(); field.focus({ preventScroll: true });
    };
    const resize = new ResizeObserver(schedule); resize.observe(screen); resize.observe(top); resize.observe(bottom);
    viewport?.addEventListener('resize', schedule); viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule); screen.addEventListener('pointerdown', focus); screen.addEventListener('focusin', schedule); screen.addEventListener('focusout', schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); viewport?.removeEventListener('resize', schedule); viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule); screen.removeEventListener('pointerdown', focus); screen.removeEventListener('focusin', schedule); screen.removeEventListener('focusout', schedule);
      screen.style.removeProperty('--conversation-keyboard-offset'); screen.style.removeProperty('--conversation-top-inset'); screen.style.removeProperty('--conversation-bottom-inset');
      screen.style.removeProperty('--conversation-composer-room');
      delete screen.dataset.keyboardOpen;
      if (previous === null) html.removeAttribute('data-conversation-active'); else html.setAttribute('data-conversation-active', previous);
    };
  }, [root, header, footer, active]);
}
