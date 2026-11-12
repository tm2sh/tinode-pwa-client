import type { AvatarResource } from '../../chats/chat-list-types';
import { ChatAvatar } from '../../chats/ui/ChatAvatar';

export function SettingsAvatar({ avatar, name }: { readonly avatar: AvatarResource; readonly name: string }) {
  return <span className="settings-avatar"><ChatAvatar avatar={avatar} name={name} /></span>;
}
