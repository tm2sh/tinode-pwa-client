import { useContextMenuTrigger } from '../../app/context-menu/useContextMenuTrigger';

export interface MessageActionTarget {
  readonly seq: number;
  readonly anchor: HTMLElement;
}

export function useMessageActionTrigger(enabled: boolean, onRequest: (target: MessageActionTarget) => boolean) {
  return useContextMenuTrigger(enabled, '[data-message-action-seq]', anchor => {
    const seq = Number(anchor.dataset.messageActionSeq);
    return Number.isSafeInteger(seq) && seq > 0 && onRequest({ seq, anchor });
  });
}
