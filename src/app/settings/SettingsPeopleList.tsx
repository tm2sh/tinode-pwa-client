import type { ReactNode, Ref } from 'react';
import type { AvatarResource } from '../../chats/chat-list-types';
import { ChatAvatar } from '../../chats/ui/ChatAvatar';
import { AppIcon } from '../AppIcon';

export interface SettingsPerson {
  readonly id: string;
  readonly name: string;
  readonly avatar: AvatarResource;
  readonly badge?: string;
}

export function SettingsPeopleList({ people, listRef, onSelect, disabled, selection, renderAction }: {
  readonly people: readonly SettingsPerson[];
  readonly listRef?: Ref<HTMLUListElement>;
  readonly onSelect?: (id: string) => void;
  readonly disabled?: boolean;
  readonly renderAction?: (person: SettingsPerson) => ReactNode;
  readonly selection?: {
    readonly checked: ReadonlySet<string>;
    readonly onToggle: (id: string) => void;
    readonly limitReached: boolean;
  };
}) {
  return <ul ref={listRef} className="settings-list">
    {people.map(person => {
      const { id, name, avatar, badge } = person;
      const content = <>
        <span className="settings-person-avatar"><ChatAvatar avatar={avatar} name={name} /></span>
        <span className="settings-person-name">{name}</span>
        {badge && <span className="settings-person-badge">{badge}</span>}
      </>;
      return <li key={id} data-person-id={id} className={'settings-list-row settings-person' + (onSelect || selection ? ' is-interactive' : '')}>
        {selection ? <label className="settings-person-action settings-person-choice">
          {content}
          <span className="settings-person-check">
            <input type="checkbox" checked={selection.checked.has(id)}
              disabled={disabled || (selection.limitReached && !selection.checked.has(id))}
              onChange={() => selection.onToggle(id)} />
            <AppIcon name="check" />
          </span>
        </label> : onSelect ? <button type="button" className="settings-person-action" disabled={disabled}
          onClick={() => onSelect(id)}>{content}</button> : <>{content}{renderAction?.(person)}</>}
      </li>;
    })}
  </ul>;
}
