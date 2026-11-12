import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';
import type { ConversationController } from '../ConversationController';
import type { ConversationMessageView } from '../conversation-presenter';

// The DOM window includes overscan, so an element's presence in the DOM does not make it visible.
export function useConversationVisibility(controller: ConversationController,
  scrollerRef: RefObject<HTMLDivElement | null>, listRef: RefObject<HTMLOListElement | null>,
  items: readonly ConversationMessageView[], overlayVisible: boolean, forwardState: 'idle' | 'pending' | 'failed', obscured = false) {
  useLayoutEffect(() => {
    if (obscured) {
      controller.setViewportActive(false);
      return;
    }
    const scroller = scrollerRef.current, list = listRef.current;
    if (!scroller || !list) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const active = document.visibilityState === 'visible' && document.hasFocus() && scroller.isConnected &&
        scroller.getClientRects().length > 0 && getComputedStyle(scroller).visibility === 'visible';
      controller.setViewportActive(active);
      if (!active) return;
      const bounds = scroller.getBoundingClientRect(), style = getComputedStyle(scroller), viewport = window.visualViewport;
      const top = Math.max(bounds.top + (parseFloat(style.paddingTop) || 0), viewport?.offsetTop ?? 0, 0);
      const overlay = scroller.closest('.conversation-screen')?.querySelector('.conversation-latest, .conversation-search-nav');
      const bottom = Math.min(overlay?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY, bounds.bottom - (parseFloat(style.paddingBottom) || 0),
        viewport ? viewport.offsetTop + viewport.height : window.innerHeight, window.innerHeight);
      const left = Math.max(bounds.left, 0), right = Math.min(bounds.right, window.innerWidth);
      if (bottom <= top || right <= left) return;
      const visible: number[] = [];
      for (const row of list.querySelectorAll<HTMLElement>('[data-message-seq]')) {
        const bubble = row.querySelector('article');
        if (!bubble) continue;
        const rect = bubble.getBoundingClientRect();
        const height = Math.min(rect.bottom, bottom) - Math.max(rect.top, top);
        if (height > 0 && height >= Math.min(rect.height, bottom - top) * .5 && rect.right > left && rect.left < right) {
          const seq = Number(row.dataset.messageSeq);
          if (Number.isSafeInteger(seq) && seq > 0) visible.push(seq);
        }
      }
      controller.reportVisibleMessages(visible);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const deactivate = () => { controller.setViewportActive(false); cancelAnimationFrame(frame); frame = 0; };
    const visibility = () => { if (document.visibilityState !== 'visible') deactivate(); else schedule(); };
    const resize = new ResizeObserver(schedule); resize.observe(scroller); resize.observe(list);
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('focus', schedule); window.addEventListener('blur', deactivate);
    window.addEventListener('resize', schedule); window.addEventListener('pagehide', deactivate); window.addEventListener('pageshow', schedule);
    document.addEventListener('visibilitychange', visibility);
    window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
    schedule();
    return () => {
      deactivate(); resize.disconnect(); scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('focus', schedule); window.removeEventListener('blur', deactivate);
      window.removeEventListener('resize', schedule); window.removeEventListener('pagehide', deactivate); window.removeEventListener('pageshow', schedule);
      document.removeEventListener('visibilitychange', visibility);
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [controller, scrollerRef, listRef, items, overlayVisible, forwardState, obscured]);
}
