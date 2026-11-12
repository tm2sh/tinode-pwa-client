import { useCallback, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import '../../styles/context-menu.css';

type MenuAlignment = 'start' | 'end';

interface AnchoredActionMenuProps {
  readonly anchor: HTMLElement;
  readonly alignment?: MenuAlignment;
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly scrollContainer?: HTMLElement | null;
  readonly topBoundary?: HTMLElement | null;
  readonly bottomBoundary?: HTMLElement | null;
  readonly focusKey?: string;
  readonly highlightKey?: number;
  readonly focusTarget?: HTMLElement;
  readonly decorateHighlight?: (replica: HTMLElement, anchor: HTMLElement) => void;
}

const margin = 12;
const gap = 9;

function visualCopy(source: Node): Node | undefined {
  if (source.nodeType === Node.TEXT_NODE) return source.cloneNode();
  if (!(source instanceof Element)) return;
  if (source instanceof HTMLImageElement) {
    // Paint pixels already on screen. A second img would start its own load.
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 512 / Math.max(source.naturalWidth, source.naturalHeight));
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    if (source.complete && source.naturalWidth) canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  if (source.matches('audio, video, source, iframe, object, embed')) return;
  const copy = source.cloneNode(false) as Element;
  for (const attribute of ['id', 'tabindex', 'aria-describedby', 'aria-labelledby', 'aria-keyshortcuts']) copy.removeAttribute(attribute);
  if (copy instanceof HTMLAnchorElement) copy.removeAttribute('href');
  for (const child of source.childNodes) {
    const next = visualCopy(child);
    if (next) copy.append(next);
  }
  return copy;
}

function placeMenu(dialog: HTMLDialogElement, panel: HTMLElement, highlight: HTMLElement, anchor: HTMLElement,
  alignment: MenuAlignment, topBoundary?: HTMLElement | null, bottomBoundary?: HTMLElement | null): boolean {
  if (!anchor.isConnected || !anchor.getClientRects().length) return false;
  const bounds = dialog.getBoundingClientRect();
  const viewport = window.visualViewport;
  const safe = getComputedStyle(dialog);
  const left = Math.max(bounds.left, viewport?.offsetLeft ?? 0) + (parseFloat(safe.paddingLeft) || 0);
  const top = Math.max(bounds.top, viewport?.offsetTop ?? 0) + (parseFloat(safe.paddingTop) || 0);
  const right = Math.min(bounds.right, viewport ? viewport.offsetLeft + viewport.width : window.innerWidth) - (parseFloat(safe.paddingRight) || 0);
  const bottom = Math.min(bounds.bottom, viewport ? viewport.offsetTop + viewport.height : window.innerHeight) - (parseFloat(safe.paddingBottom) || 0);
  const target = anchor.getBoundingClientRect();
  const topEdge = topBoundary?.getBoundingClientRect().bottom ?? top;
  const bottomEdge = bottomBoundary?.getBoundingClientRect().top ?? bottom;
  const visibleTop = Math.max(top, target.top, topEdge);
  const visibleBottom = Math.min(bottom, target.bottom, bottomEdge);
  const visibleLeft = Math.max(left, target.left);
  const visibleRight = Math.min(right, target.right);
  if (visibleBottom <= visibleTop || visibleRight <= visibleLeft || right - left <= margin * 2) return false;

  Object.assign(highlight.style, {
    left: target.left - bounds.left + 'px', top: target.top - bounds.top + 'px',
    width: target.width + 'px', height: target.height + 'px',
    clipPath: `inset(${visibleTop - target.top}px ${target.right - visibleRight}px ${target.bottom - visibleBottom}px ${visibleLeft - target.left}px)`,
  });
  const preferredBelow = (visibleTop + visibleBottom) / 2 < (top + bottom) / 2;
  const above = visibleTop - gap - (top + margin);
  const below = bottom - margin - (visibleBottom + gap);
  panel.style.maxWidth = right - left - margin * 2 + 'px';
  const natural = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
  const useBelow = preferredBelow ? below >= natural || (above < natural && below >= above)
    : above < natural && (below >= natural || below > above);
  const room = useBelow ? below : above;
  panel.style.maxHeight = Math.max(0, room >= 46 ? room : bottom - top - 2 * margin) + 'px';
  const proposedY = useBelow ? visibleBottom + gap : visibleTop - gap - panel.offsetHeight;
  const proposedX = alignment === 'end' ? visibleRight - panel.offsetWidth : visibleLeft;
  panel.style.left = Math.min(Math.max(proposedX, left + margin), right - margin - panel.offsetWidth) - bounds.left + 'px';
  panel.style.top = Math.min(Math.max(proposedY, top + margin), bottom - margin - panel.offsetHeight) - bounds.top + 'px';
  panel.dataset.side = useBelow ? 'below' : 'above';
  return true;
}

export function AnchoredActionMenu({ anchor, alignment = 'start', label, onClose, children,
  scrollContainer, topBoundary, bottomBoundary, focusKey, highlightKey, focusTarget = anchor, decorateHighlight }: AnchoredActionMenuProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const highlight = useRef<HTMLDivElement>(null);
  const backdropPress = useRef(false);

  const reposition = useCallback(() => {
    const node = dialog.current, menu = panel.current, copy = highlight.current;
    if (node?.open && menu && copy &&
      !placeMenu(node, menu, copy, anchor, alignment, topBoundary, bottomBoundary)) onClose();
  }, [anchor, alignment, topBoundary, bottomBoundary, onClose]);

  useLayoutEffect(() => {
    const copy = highlight.current;
    if (!copy) return;
    const replica = visualCopy(anchor);
    if (replica instanceof HTMLElement) {
      replica.style.borderRadius = getComputedStyle(anchor).borderRadius;
      decorateHighlight?.(replica, anchor);
      copy.replaceChildren(replica);
    }
  }, [anchor, decorateHighlight, highlightKey]);

  useLayoutEffect(() => {
    const node = dialog.current;
    const menu = panel.current;
    if (!node || !menu) return;

    node.showModal();
    scrollContainer?.setAttribute('data-anchored-action-scroll-locked', '');
    let frame = 0;
    const measure = () => {
      frame = 0;
      reposition();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    for (const element of [anchor, node, menu, topBoundary, bottomBoundary]) {
      if (element) observer.observe(element);
    }
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    scrollContainer?.addEventListener('scroll', schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      scrollContainer?.removeEventListener('scroll', schedule);
      scrollContainer?.removeAttribute('data-anchored-action-scroll-locked');
      node.close();
      if (focusTarget.isConnected && focusTarget.getClientRects().length) focusTarget.focus({ preventScroll: true });
      else if (scrollContainer?.isConnected) scrollContainer.focus({ preventScroll: true });
    };
  }, [anchor, scrollContainer, topBoundary, bottomBoundary, focusTarget, reposition]);

  // A keyed card can move without resizing or scrolling when the list is reordered.
  useLayoutEffect(reposition);

  useLayoutEffect(() => {
    const menu = panel.current;
    if (menu) (menu.querySelector<HTMLButtonElement>('button:enabled') ?? menu).focus({ preventScroll: true });
  }, [focusKey]);

  return <dialog ref={dialog} className="anchored-action-dialog" aria-label={label}
    onCancel={event => { event.preventDefault(); onClose(); }} onContextMenu={event => event.preventDefault()}>
    <div className="anchored-action-outside" aria-hidden="true"
      onPointerDown={() => { backdropPress.current = true; }}
      onPointerCancel={() => { backdropPress.current = false; }}
      onClick={() => {
        if (!backdropPress.current) return;
        backdropPress.current = false;
        onClose();
      }} />
    <div ref={highlight} className="anchored-action-highlight" data-alignment={alignment} aria-hidden="true" inert />
    <div ref={panel} className="anchored-action-panel" tabIndex={-1}>{children}</div>
  </dialog>;
}
