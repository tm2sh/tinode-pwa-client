import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

type StandaloneNavigator = Navigator & { readonly standalone?: boolean };

// Preserve the behavior from ../cht-pwa by keeping the same input nodes and avoiding offsetTop compensation.
export function useAuthViewport(screenRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;

    const root = document.documentElement;
    const viewport = window.visualViewport;
    const displayMode = window.matchMedia('(display-mode: standalone)');
    const attributes = ['data-auth-ios-pwa', 'data-auth-standalone', 'data-auth-editing', 'data-auth-keyboard'];
    const previousAttributes = attributes.map((name) => [name, root.getAttribute(name)] as const);
    const previousHeight = root.style.getPropertyValue('--auth-keyboard-height');
    const previousPriority = root.style.getPropertyPriority('--auth-keyboard-height');
    let frame = 0;
    let focusOutTimer: ReturnType<typeof setTimeout> | undefined;
    let stableHeight = window.innerHeight;
    let stableWidth = window.innerWidth;
    let managingFocus = false;
    let managedTouch = false;
    let disposed = false;

    function updateDisplayMode() {
      const iosPwa = (navigator as StandaloneNavigator).standalone === true;
      root.dataset.authIosPwa = String(iosPwa);
      root.dataset.authStandalone = String(iosPwa || displayMode.matches);
    }

    function updateViewport() {
      frame = 0;
      if (disposed || (viewport && Math.abs(viewport.scale - 1) > 0.01)) return;

      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      if (Math.abs(width - stableWidth) > 40) {
        stableWidth = width;
        stableHeight = window.innerHeight;
      }
      const active = document.activeElement;
      const editing = active instanceof HTMLElement && screen!.contains(active) &&
        active.matches('input, textarea, [contenteditable="true"]');
      if (!editing) stableHeight = Math.max(stableHeight, window.innerHeight);
      // When moving between fields, iOS may briefly focus the document while keeping the keyboard open.
      const wasOpen = root.dataset.authKeyboard === 'open';
      const keyboardOpen = (editing || wasOpen) &&
        Math.max(stableHeight, window.innerHeight) - height > 120;
      root.dataset.authKeyboard = keyboardOpen ? 'open' : 'closed';

      if (keyboardOpen) {
        root.style.setProperty('--auth-keyboard-height', height + 'px');
        if (editing && active instanceof HTMLInputElement) {
          // Scroll the registration screen itself when the form is taller than the viewport.
          const bounds = screen!.getBoundingClientRect();
          const field = active.getBoundingClientRect();
          const padding = getComputedStyle(screen!);
          const top = bounds.top + parseFloat(padding.paddingTop);
          const bottom = bounds.bottom - parseFloat(padding.paddingBottom);
          if (field.bottom > bottom) screen!.scrollTop += field.bottom - bottom;
          else if (field.top < top) screen!.scrollTop += field.top - top;
        }
      } else root.style.removeProperty('--auth-keyboard-height');

      // Preserve scroll position and ignore visualViewport.offsetTop while the user types.
      if (!keyboardOpen && !editing && root.dataset.authEditing === 'true') {
        if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
        delete root.dataset.authEditing;
      }
    }

    function scheduleViewport() {
      if (!disposed && !frame) frame = requestAnimationFrame(updateViewport);
    }

    function prepareFocus() {
      if (root.dataset.authIosPwa === 'true') root.dataset.authEditing = 'true';
    }

    function focusField(field: HTMLInputElement) {
      prepareFocus();
      managingFocus = true;
      try { field.focus({ preventScroll: true }); }
      finally { managingFocus = false; }
    }

    function isAuthField(value: EventTarget | null): value is HTMLInputElement {
      return value instanceof HTMLInputElement && screen!.contains(value) &&
        value.matches('.auth-field input') && !value.disabled && !value.readOnly;
    }

    function focusIn(event: FocusEvent) {
      prepareFocus();
      const field = event.target;
      const previous = event.relatedTarget;
      if (root.dataset.authIosPwa !== 'true' || managingFocus ||
        root.dataset.authKeyboard !== 'open' || !isAuthField(field) || !isAuthField(previous)) return;

      // The UIKit keyboard arrows bypass pointerdown. Handle the focus change synchronously
      // to keep the keyboard session open and prevent native scrolling.
      managingFocus = true;
      try {
        previous.focus({ preventScroll: true });
        field.focus({ preventScroll: true });
      } finally { managingFocus = false; }
    }

    function pointerDown(event: PointerEvent) {
      if (root.dataset.authIosPwa !== 'true' || !event.isPrimary || event.button !== 0 ||
        !(event.target instanceof Element)) return;
      const field = event.target.closest('.auth-field')?.querySelector('input');
      if (!field || event.target.closest('button') || document.activeElement === field) return;
      event.preventDefault();
      managedTouch = event.pointerType === 'touch';
      focusField(field);
    }

    // After the form moves, iOS may send the synthesized click to the background.
    // Suppress that click only after a handled touch. Keep native behavior for the active field.
    function touchEnd(event: TouchEvent) {
      if (!managedTouch) return;
      managedTouch = false;
      if (event.cancelable) event.preventDefault();
    }

    function pointerCancel() {
      managedTouch = false;
    }

    function keyDown(event: KeyboardEvent) {
      if (event.key !== 'Enter' || event.isComposing || !isAuthField(event.target) ||
        event.target.name !== 'username') return;
      const password = screen!.querySelector<HTMLInputElement>('input[name="password"]');
      if (!password) return;
      event.preventDefault();
      focusField(password);
    }

    function focusOut() {
      scheduleViewport();
      clearTimeout(focusOutTimer);
      // The keyboard finishes closing after focusout.
      focusOutTimer = setTimeout(scheduleViewport, 350);
    }

    function displayModeChanged() {
      updateDisplayMode();
      scheduleViewport();
    }

    window.addEventListener('resize', scheduleViewport, { passive: true });
    window.addEventListener('scroll', scheduleViewport, { passive: true });
    window.addEventListener('pageshow', scheduleViewport);
    viewport?.addEventListener('resize', scheduleViewport, { passive: true });
    viewport?.addEventListener('scroll', scheduleViewport, { passive: true });
    document.addEventListener('focusin', scheduleViewport);
    document.addEventListener('focusout', focusOut);
    displayMode.addEventListener('change', displayModeChanged);
    screen.addEventListener('focusin', focusIn);
    screen.addEventListener('pointerdown', pointerDown);
    screen.addEventListener('touchend', touchEnd, { passive: false });
    screen.addEventListener('pointercancel', pointerCancel);
    screen.addEventListener('keydown', keyDown);
    updateDisplayMode();
    updateViewport();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(focusOutTimer);
      window.removeEventListener('resize', scheduleViewport);
      window.removeEventListener('scroll', scheduleViewport);
      window.removeEventListener('pageshow', scheduleViewport);
      viewport?.removeEventListener('resize', scheduleViewport);
      viewport?.removeEventListener('scroll', scheduleViewport);
      document.removeEventListener('focusin', scheduleViewport);
      document.removeEventListener('focusout', focusOut);
      displayMode.removeEventListener('change', displayModeChanged);
      screen.removeEventListener('focusin', focusIn);
      screen.removeEventListener('pointerdown', pointerDown);
      screen.removeEventListener('touchend', touchEnd);
      screen.removeEventListener('pointercancel', pointerCancel);
      screen.removeEventListener('keydown', keyDown);
      for (const [name, value] of previousAttributes) {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      }
      if (previousHeight) root.style.setProperty('--auth-keyboard-height', previousHeight, previousPriority);
      else root.style.removeProperty('--auth-keyboard-height');
    };
  }, [screenRef]);
}
