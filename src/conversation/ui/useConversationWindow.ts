import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ConversationMessageView } from '../conversation-presenter';
import type { ConversationOpeningTarget, ConversationReadySnapshot, ConversationOutgoing, ConversationScrollAnchor } from '../conversation-types';

const windowSize = 80;
interface Anchor { readonly seq: number; readonly offset: number; readonly atEnd: boolean }
interface Metrics { width: number; height: number; top: number; bottom: number; leading: number }

// The window limits the DOM only. The controller retains the full text and models.
export function useConversationWindow(items: readonly ConversationMessageView[], target: ConversationOpeningTarget,
  scrollerRef: RefObject<HTMLDivElement | null>, listRef: RefObject<HTMLOListElement | null>, leadingRef: RefObject<HTMLDivElement | null>, followLatest: boolean, request: ConversationReadySnapshot['position']['scrollRequest'], onEndPosition: (atEnd: boolean) => void, outgoing: readonly ConversationOutgoing[], onAnchor: (anchor: ConversationScrollAnchor) => void,
  searchSeq?: number, searchQuery?: string) {
  const rows = useRef(new Map<number, HTMLLIElement>());
  const heights = useRef(new Map<number, number>());
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const anchor = useRef<Anchor | undefined>(undefined);
  const initialized = useRef(false);
  const handledRequest = useRef(0);
  const handledSearch = useRef<{ seq: number | undefined; query: string | undefined }>({ seq: undefined, query: undefined });
  const pendingTarget = useRef<{ key: 'latest' | number; search: boolean } | undefined>(undefined);
  const metrics = useRef<Metrics>({ width: 0, height: 0, top: 0, bottom: 0, leading: 0 });
  const [measurement, setMeasurement] = useState(0);
  const [cursor, setCursor] = useState<number | undefined>(target.kind === 'message' ? target.serverSeq : undefined);
  const layout = useRef<{ items: readonly ConversationMessageView[]; offsets: readonly number[] }>({ items: [], offsets: [0] });
  const offsets = useMemo(() => {
    const values = [0], width = metrics.current.width || 360;
    for (const item of items) {
      const available = Math.max(80, width - 100);
      const lines = Math.max(1, item.message.content.text.text.split('\n').reduce((n, text) => n + Math.max(1, Math.ceil(text.length * 7.2 / available)), 0));
      const attachmentHeight = item.message.content.attachments.reduce((sum, part) => {
        if (part.kind !== 'photo' || !part.preview) return sum + 68;
        const ratio = part.dimensions.state === 'known' ? Math.min(2, Math.max(1, part.dimensions.width / part.dimensions.height)) : 4 / 3;
        return sum + Math.min(236, available) / ratio + 8;
      }, 0);
      const photos = item.message.content.attachments.filter(part => part.kind === 'photo');
      const photoOnly = photos.length > 0 && photos.length === item.message.content.attachments.length;
      const mediaHeight = photoOnly ? (photos.length > 1 ? Math.min(302, available) / (photos.length === 2 ? 1.24 : 1.07)
        : Math.min(480, Math.min(302, available) / (photos[0]!.dimensions.state === 'known'
          ? Math.min(4, Math.max(.25, photos[0]!.dimensions.width / photos[0]!.dimensions.height)) : 4 / 3))) + 8 : attachmentHeight;
      const estimate = 47 + lines * 22 + (item.showSenderName ? 26 : 0) + (item.dateSeparator ? 38 : 0) + mediaHeight;
      values.push(values.at(-1)! + (heights.current.get(item.key) ?? estimate));
    }
    return values;
  }, [items, measurement]);
  layout.current = { items, offsets };
  let index = cursor === undefined ? items.length - 1 : items.findIndex(item => item.key === cursor);
  if (index < 0) index = items.length - 1;
  const start = Math.max(0, Math.min(Math.max(0, items.length - windowSize), index - 24));
  const end = Math.min(items.length, start + windowSize);

  const capture = useCallback(() => {
    const node = scrollerRef.current, list = listRef.current;
    if (!node || !list) return;
    const atEnd = node.scrollHeight - node.scrollTop - node.clientHeight <= 1;
    onEndPosition(atEnd);
    if (layout.current.items.length === 0) return;
    const bounds = node.getBoundingClientRect(), top = parseFloat(getComputedStyle(node).paddingTop) || 0;
    const visible = bounds.top + top;
    const found = [...rows.current].filter(([, row]) => row.getBoundingClientRect().bottom > visible + .5 && row.getBoundingClientRect().top < bounds.bottom)
      .sort((a, b) => a[1].getBoundingClientRect().top - b[1].getBoundingClientRect().top)[0];
    let seq: number, offset: number;
    if (found) { seq = found[0]; offset = found[1].getBoundingClientRect().top - visible; }
    else {
      const current = layout.current;
      const contentTop = list.getBoundingClientRect().top - bounds.top + node.scrollTop;
      const relative = node.scrollTop + top - contentTop;
      let lo = 0, hi = current.items.length;
      while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (current.offsets[mid + 1] <= relative) lo = mid + 1; else hi = mid; }
      const selected = Math.min(lo, current.items.length - 1);
      seq = current.items[selected].key; offset = contentTop + current.offsets[selected] - node.scrollTop - top;
    }
    anchor.current = { seq, offset, atEnd };
    onAnchor({ serverSeq: seq, offsetPx: offset });
    setCursor(previous => previous === seq ? previous : seq);
  }, [scrollerRef, listRef, onEndPosition, onAnchor]);

  const onRowRef = useCallback((seq: number, row: HTMLLIElement | null) => {
    const previous = rows.current.get(seq);
    if (previous && previous !== row) observer.current?.unobserve(previous);
    if (row) { rows.current.set(seq, row); observer.current?.observe(row); }
    else rows.current.delete(seq);
  }, []);

  useLayoutEffect(() => {
    const node = scrollerRef.current, list = listRef.current;
    if (!node || !list) return;
    let frame = 0;
    const measure = () => {
      const style = getComputedStyle(node);
      const next: Metrics = { width: node.clientWidth, height: node.clientHeight,
        top: parseFloat(style.paddingTop) || 0, bottom: parseFloat(style.paddingBottom) || 0,
        leading: leadingRef.current?.getBoundingClientRect().height ?? 0 };
      const old = metrics.current;
      const resized = old.width > 0 && Math.abs(next.width - old.width) > .5;
      let changed = resized || Object.keys(next).some(key => next[key as keyof Metrics] !== old[key as keyof Metrics]);
      if (resized) heights.current.clear();
      metrics.current = next;
      for (const [seq, row] of rows.current) {
        const height = row.getBoundingClientRect().height;
        if (height > 0 && Math.abs(height - (heights.current.get(seq) ?? -1)) > .5) { heights.current.set(seq, height); changed = true; }
      }
      if (changed) setMeasurement(value => value + 1);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule); observer.current = resize;
    resize.observe(node); if (leadingRef.current) resize.observe(leadingRef.current);
    for (const row of rows.current.values()) resize.observe(row);
    const keyboard = (event: KeyboardEvent) => {
      if ((event.key !== 'Home' && event.key !== 'End') || event.altKey || event.metaKey || layout.current.items.length === 0) return;
      event.preventDefault();
      const atEnd = event.key === 'End';
      const seq = (atEnd ? layout.current.items.at(-1)! : layout.current.items[0]).key;
      anchor.current = { seq, offset: atEnd ? 0 : metrics.current.leading, atEnd };
      setCursor(seq);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { node.scrollTop = atEnd ? node.scrollHeight : 0; measure(); capture(); });
    };
    node.addEventListener('scroll', capture, { passive: true }); node.addEventListener('keydown', keyboard);
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); observer.current = undefined;
      node.removeEventListener('scroll', capture); node.removeEventListener('keydown', keyboard); window.removeEventListener('resize', schedule);
    };
  }, [capture, leadingRef, listRef, scrollerRef]);

  useLayoutEffect(() => {
    const node = scrollerRef.current, list = listRef.current;
    if (!node || !list) return;
    if (items.length === 0) {
      if (request.id !== handledRequest.current) { handledRequest.current = request.id; node.scrollTop = node.scrollHeight; }
      capture(); return;
    }
    const saved = anchor.current;
    const searchChanged = searchSeq !== handledSearch.current.seq || searchQuery !== handledSearch.current.query;
    if (searchChanged) handledSearch.current = { seq: searchSeq, query: searchQuery };
    if (request.id !== handledRequest.current) {
      handledRequest.current = request.id;
      pendingTarget.current = { key: request.target, search: false };
    } else if (searchChanged) {
      if (searchSeq !== undefined) pendingTarget.current = { key: searchSeq, search: true };
      else if (pendingTarget.current?.search) pendingTarget.current = undefined;
    }
    const pending = pendingTarget.current;
    if (pending) {
      const key = pending.key === 'latest' ? items.at(-1)!.key : pending.key;
      const row = rows.current.get(key);
      if (!row) { setCursor(key); return; }
      if (pending.key === 'latest') node.scrollTop = node.scrollHeight;
      else if (pending.search) {
        const bounds = node.getBoundingClientRect(), style = getComputedStyle(node);
        const top = bounds.top + (parseFloat(style.paddingTop) || 0);
        const navigation = node.closest('.conversation-screen')?.querySelector('.conversation-search-nav');
        const bottom = Math.min(bounds.bottom - (parseFloat(style.paddingBottom) || 0),
          navigation?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY);
        const bubble = row.querySelector('article') ?? row;
        const match = bubble.getBoundingClientRect().height > bottom - top
          ? row.querySelector('.conversation-search-hit') ?? bubble : bubble;
        node.scrollTop += match.getBoundingClientRect().top - top - 4;
      } else node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - metrics.current.top;
      pendingTarget.current = undefined; capture(); return;
    }
    if (!initialized.current) {
      initialized.current = true;
      if (target.kind === 'empty' || target.reason === 'latest') node.scrollTop = node.scrollHeight;
      else {
        const row = rows.current.get(target.serverSeq);
        if (row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - metrics.current.top -
          (target.reason === 'resume' ? target.offsetPx ?? 0 : 0);
      }
    } else if (saved?.atEnd && followLatest) node.scrollTop = node.scrollHeight;
    else if (saved) {
      const row = rows.current.get(saved.seq);
      if (row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - metrics.current.top - saved.offset;
      else {
        const at = items.findIndex(item => item.key === saved.seq);
        if (at >= 0) node.scrollTop = list.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop + offsets[at] - metrics.current.top - saved.offset;
      }
    }
    capture();
  }, [capture, end, items, measurement, offsets, start, target, followLatest, request.id, request.target, outgoing, searchSeq, searchQuery]);

  useLayoutEffect(() => {
    const existing = new Set(items.map(item => item.key));
    for (const seq of heights.current.keys()) if (!existing.has(seq)) heights.current.delete(seq);
  }, [items]);

  return { start, end, top: offsets[start], bottom: offsets[items.length] - offsets[end], onRowRef, captureAnchor: capture };
}
