import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

const keyboardThreshold = 48;
const fieldGap = 10;

export function useSettingsEditorKeyboard(screenRef: RefObject<HTMLElement | null>, editing: boolean): void {
  useLayoutEffect(() => {
    const screen = screenRef.current, viewport = window.visualViewport;
    const field = screen?.querySelector<HTMLInputElement>('.settings-editor-name');
    const save = field?.form?.querySelector<HTMLButtonElement>('.settings-editor-save');
    if (!editing || !screen || !viewport || !field || !save) return;

    let frame = 0;
    let width = window.innerWidth, fullHeight = window.innerHeight;
    let keyboardHeight: number | undefined;
    let startScroll = 0, adjustedScroll: number | undefined;
    const clearHeight = () => {
      const restore = adjustedScroll !== undefined && Math.abs(screen.scrollTop - adjustedScroll) < 1;
      screen.style.removeProperty('--settings-editor-viewport-height');
      if (restore) screen.scrollTop = startScroll;
      keyboardHeight = undefined;
      adjustedScroll = undefined;
    };
    const measure = () => {
      frame = 0;
      if (Math.abs(viewport.scale - 1) > .01) return;
      const focused = document.activeElement === field;
      if (width !== window.innerWidth || (!focused && keyboardHeight === undefined)) {
        width = window.innerWidth;
        fullHeight = window.innerHeight;
      }
      const height = Math.round(viewport.height);
      const keyboardOpen = (focused || keyboardHeight !== undefined) &&
        Math.max(fullHeight, window.innerHeight) - height >= keyboardThreshold;
      if (!keyboardOpen) {
        if (keyboardHeight !== undefined) clearHeight();
        return;
      }
      if (keyboardHeight === height) return;
      if (keyboardHeight === undefined) startScroll = screen.scrollTop;
      keyboardHeight = height;
      screen.style.setProperty('--settings-editor-viewport-height', height + 'px');
      if (!focused) return;

      const bounds = screen.getBoundingClientRect();
      const input = field.getBoundingClientRect(), action = save.getBoundingClientRect();
      const top = bounds.top + (parseFloat(getComputedStyle(screen).paddingTop) || 0);
      const bottom = bounds.bottom - fieldGap;
      const target = action.bottom - input.top <= bottom - top ? action.bottom : input.bottom;
      if (target > bottom) {
        screen.scrollTop += target - bottom;
        adjustedScroll = screen.scrollTop;
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const focusField = (event: PointerEvent) => {
      if ((navigator as Navigator & { standalone?: boolean }).standalone !== true ||
        event.pointerType !== 'touch' || !event.isPrimary || field.disabled || document.activeElement === field) return;
      event.preventDefault();
      field.focus({ preventScroll: true });
    };
    viewport.addEventListener('resize', schedule);
    window.addEventListener('resize', schedule);
    field.addEventListener('focus', schedule);
    field.addEventListener('blur', schedule);
    field.addEventListener('pointerdown', focusField);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      window.removeEventListener('resize', schedule);
      field.removeEventListener('focus', schedule);
      field.removeEventListener('blur', schedule);
      field.removeEventListener('pointerdown', focusField);
      if (keyboardHeight !== undefined) clearHeight();
    };
  }, [editing, screenRef]);
}
