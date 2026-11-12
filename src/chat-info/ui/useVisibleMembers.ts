import { useEffect, useRef } from 'react';
import type { ChatInfoMember } from '../chat-info-types';

// Observe visible rows to load their photos on demand. The DOM stores only user IDs.
export function useVisibleMembers(members: readonly ChatInfoMember[], onVisible: (uids: readonly string[]) => void) {
  const list = useRef<HTMLUListElement>(null);
  const key = members.map(member => member.uid).join('|');
  useEffect(() => {
    const element = list.current, root = element?.closest<HTMLElement>('.chat-info-screen');
    if (!element || !root) { onVisible([]); return; }
    const rows = [...element.querySelectorAll<HTMLElement>('[data-person-id]')];
    const visible = new Set<string>();
    let frame = 0;
    const publish = () => onVisible(document.visibilityState === 'hidden' ? [] : rows
      .filter(row => visible.has(row.dataset.personId!)).map(row => row.dataset.personId!));
    const measure = () => {
      frame = 0; visible.clear();
      const bounds = root.getBoundingClientRect();
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom >= bounds.top - 120 && rect.top <= bounds.bottom + 120) visible.add(row.dataset.personId!);
      }
      publish();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        const uid = (entry.target as HTMLElement).dataset.personId!;
        if (entry.isIntersecting) visible.add(uid); else visible.delete(uid);
      }
      publish();
    }, { root, rootMargin: '120px 0px' }) : undefined;
    for (const row of rows) observer?.observe(row);
    if (!observer) root.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', measure);
    measure();
    return () => {
      observer?.disconnect(); if (frame) cancelAnimationFrame(frame);
      root.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', measure); onVisible([]);
    };
  }, [key, onVisible]);
  return list;
}
