import { useLayoutEffect } from 'react';
import type { KeyboardEventHandler, Ref, RefObject } from 'react';
import { AppIcon } from './AppIcon';
import '../styles/header-search.css';

interface HeaderSearchFieldProps {
  readonly id: string;
  readonly input: RefObject<HTMLInputElement | null>;
  readonly label: string;
  readonly placeholder: string;
  readonly inputLabel?: string;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  readonly status?: string | null;
}

export function HeaderSearchField({ id, input, label, placeholder, inputLabel, disabled, autoFocus = true, query, onQuery, onKeyDown, status }: HeaderSearchFieldProps) {
  useLayoutEffect(() => { if (autoFocus) input.current?.focus({ preventScroll: true }); }, [autoFocus, input]);
  return <div id={id} className="header-glass-pill header-search-field" role="search" aria-label={label}>
    <AppIcon name="search" />
    <div className="header-search-copy">
      <input ref={input} type="search" value={query} onChange={event => onQuery(event.currentTarget.value)}
        onKeyDown={onKeyDown} aria-label={inputLabel ?? placeholder} placeholder={placeholder}
        disabled={disabled} autoComplete="off" autoCapitalize="none" enterKeyHint="search" />
      {status !== undefined && <p role="status">{status}</p>}
    </div>
  </div>;
}

interface HeaderSearchToggleProps {
  readonly buttonRef: Ref<HTMLButtonElement>;
  readonly open: boolean;
  readonly label: string;
  readonly panelId: string;
  readonly disabled?: boolean;
  readonly onToggle: () => void;
}

export function HeaderSearchToggle({ buttonRef, open, label, panelId, disabled, onToggle }: HeaderSearchToggleProps) {
  return <button ref={buttonRef} type="button" className="header-glass-button header-search-toggle" disabled={disabled}
    aria-label={label} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle}>
    <AppIcon name={open ? 'close' : 'search'} />
  </button>;
}
