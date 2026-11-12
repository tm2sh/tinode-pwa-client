import { useTranslation } from 'react-i18next';
import { useScreenTranslations } from '../i18n';
import { AppIcon } from './AppIcon';
import { authErrorText } from '../i18n/auth-error';
import { useId, useRef, useState } from 'react';
import type { AuthError } from '../auth/auth-types';
import type { AccountScope, CurrentUserProfile } from '../chats/chat-list-types';
import type { ConfirmedOwnProfile, OwnProfilePort, OwnProfileSaveResult } from '../profile/own-profile-types';
import '../styles/profile-panel.css';
import { SettingsHeader } from './settings/SettingsHeader';
import { SettingsAvatar } from './settings/SettingsAvatar';
import { SettingsSwitch } from './settings/SettingsSwitch';
import { useSettingsEditorKeyboard } from './settings/useSettingsEditorKeyboard';
import { ProfileEditor } from './ProfileEditor';
import { ProfilePreferences } from './ProfilePreferences';

interface ProfilePanelProps {
  readonly profile?: CurrentUserProfile;
  readonly onRetryProfile: () => Promise<void>;
  readonly onProfileSaved: (account: AccountScope) => void;
  readonly openOwnProfilePort: () => Promise<OwnProfilePort>;
  readonly warning?: AuthError;
  readonly onBack: () => void;
  readonly onLogout: () => void;
}

export function ProfilePanel({ profile, onRetryProfile, onProfileSaved, openOwnProfilePort, warning, onBack, onLogout }: ProfilePanelProps) {
  useScreenTranslations('profile');
  const { t } = useTranslation('profile');
  const { t: commonT } = useTranslation('common');
  const { t: errorT } = useTranslation('errors');
  const titleId = useId();
  const notificationsLabelId = useId();
  const screen = useRef<HTMLElement>(null);
  const [retrying, setRetrying] = useState(false);
  const [editing, setEditing] = useState<ConfirmedOwnProfile>();
  const [localConfirmation, setLocalConfirmation] = useState<ConfirmedOwnProfile>();
  useSettingsEditorKeyboard(screen, editing !== undefined);
  const displayed = localConfirmation ?? profile;
  const available = displayed?.state === 'available' ? displayed : undefined;
  const loading = !displayed || displayed.state === 'pending';
  const name = available?.displayName.state === 'known' ? available.displayName.text : '';
  const confirm: (result: Extract<OwnProfileSaveResult, { state: 'confirmed' }>) => void = ({ profile, account }) => {
    const avatar = profile.avatar.state === 'pending' && editing?.avatar.state === 'ready' ? editing.avatar : profile.avatar;
    setLocalConfirmation({ ...profile, avatar });
    setEditing(undefined);
    onProfileSaved(account);
  };
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try { await onRetryProfile(); }
    finally { setRetrying(false); }
  };

  return (
    <section ref={screen} className="chats-screen settings-screen profile-panel" aria-labelledby={titleId}>
      <SettingsHeader title={t($ => $.title)} titleId={titleId} onBack={onBack}
        action={editing ? { label: commonT($ => $.cancel), onClick: () => setEditing(undefined) }
          : available ? { label: t($ => $.edit.action), onClick: () => setEditing(available) } : undefined} />
      {warning && <p className="chats-warning" role="alert">{authErrorText(errorT, warning)}</p>}
      <div className="profile-content">
        <div className="profile-identity">
          {editing ? <ProfileEditor profile={editing} openPort={openOwnProfilePort} onConfirmed={confirm} /> : <>
            {available && <>
              <SettingsAvatar avatar={available.avatar} name={name} />
              <h2>{name || t($ => $.unknownName)}</h2>
            </>}
            {(loading || retrying) && <div className="profile-loading" role="status">
              <AppIcon name="spinner" className="auth-spinner" />
              <span>{t($ => $.loading)}</span>
            </div>}
            {displayed?.state === 'unavailable' && !retrying && <>
              <p className="profile-error" role="alert">{errorT($ => $[displayed.error.messageCode])}</p>
              {displayed.error.retryable && <button className="profile-retry" type="button" onClick={() => { void retry(); }}>
                {commonT($ => $.retry)}
              </button>}
            </>}
          </>}
        </div>
        <div className="settings-row profile-notifications">
          <span id={notificationsLabelId}>{t($ => $.notifications)}</span>
          <SettingsSwitch checked={false} labelId={notificationsLabelId} disabled />
        </div>
        <ProfilePreferences />
        <button className="profile-logout" type="button" onClick={onLogout}>
          <AppIcon name="logout" />
          <span>{t(($) => $.logout)}</span>
        </button>
      </div>
    </section>
  );
}
