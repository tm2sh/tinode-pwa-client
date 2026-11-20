import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { AppIcon } from '../../app/AppIcon';
import { useTranslation } from 'react-i18next';
import { loadTranslations, useScreenTranslations } from '../../i18n';
import { ProtectedScreenFailure, ProtectedScreenLoading } from '../../app/ProtectedScreenLoading';
import { ScreenBoundary } from '../../app/ScreenBoundary';
import { SettingsAvatar } from '../../app/settings/SettingsAvatar';
import { SettingsHeader } from '../../app/settings/SettingsHeader';
import { SettingsSwitch } from '../../app/settings/SettingsSwitch';
import { SettingsPeopleList } from '../../app/settings/SettingsPeopleList';
import type { ServerLimit } from '../../media/MediaResources';
import type { ConversationPresence } from '../../conversation/conversation-types';
import { ChatInfoController } from '../ChatInfoController';
import type { ChatInfoError, ChatInfoGroupPatch, ChatInfoGroupSaveResult, ChatInfoMembersState, ChatInfoMuteState, ChatInfoSnapshot } from '../chat-info-types';
import { canManageChatInfoMembers } from '../chat-info-normalize';
import { MemberRemovalDialog } from './MemberRemovalDialog';
import type { ChatInfoRouteProps } from './ChatInfoRoute';
import { GroupEditor } from './GroupEditor';
import { useVisibleMembers } from './useVisibleMembers';
import { useSettingsEditorKeyboard } from '../../app/settings/useSettingsEditorKeyboard';
import chatInfoStyles from '../../styles/chat-info.css?inline';

const hotControllers = import.meta.hot ? new Set<ChatInfoController>() : undefined;
if (import.meta.hot && hotControllers) import.meta.hot.dispose(() => {
  for (const controller of hotControllers) controller.dispose();
  hotControllers.clear();
});

function loadMemberPicker() {
  return lazy(() => Promise.all([import('./AddChatMembersScreen'), loadTranslations('createGroup', { retry: true })])
    .then(([module]) => ({ default: module.AddChatMembersScreen })));
}

let memberPicker = loadMemberPicker();

export function ChatInfoRouteContent({ identity, seed, openPort, onBack, maxMessageSize, chatList }: ChatInfoRouteProps) {
  useScreenTranslations('chatInfo');
  const [controller] = useState(() => new ChatInfoController(identity, seed, openPort));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [adding, setAdding] = useState(false);
  const [pickerAttempt, setPickerAttempt] = useState(0);
  const closePicker = useCallback(() => setAdding(false), []);
  useEffect(() => {
    const release = controller.attach();
    hotControllers?.add(controller);
    void controller.start();
    return () => { hotControllers?.delete(controller); release(); };
  }, [controller]);
  useEffect(() => {
    if (snapshot.phase === 'closed') onBack();
  }, [snapshot.phase, onBack]);
  if (adding && chatList && snapshot.phase === 'ready' && snapshot.data.kind === 'group') {
    const roster = snapshot.data.members;
    const visible = roster.state === 'ready' || roster.state === 'partial' || roster.state === 'available' ? roster
      : roster.state === 'loading' || roster.state === 'failed' ? roster.lastKnown : undefined;
    const Picker = memberPicker;
    return <ScreenBoundary resetKey={String(pickerAttempt)} fallback={<ProtectedScreenFailure onBack={closePicker}
      onRetry={() => { memberPicker = loadMemberPicker(); setPickerAttempt(value => value + 1); }} />}>
      <Suspense fallback={<ProtectedScreenLoading onBack={closePicker} />}>
        <Picker chatList={chatList} ownUid={identity.account.uid} memberIds={new Set(visible?.members.map(member => member.uid))}
          onAdd={controller.addMembers} onBack={closePicker} />
      </Suspense>
    </ScreenBoundary>;
  }
  return <ChatInfoScreen snapshot={snapshot} onBack={onBack} onRetry={() => { void controller.retry(); }}
    onSetMuted={controller.setMuted} onSaveGroup={controller.saveGroup} onCheckGroupSave={controller.checkGroupSave}
    maxMessageSize={maxMessageSize} onVisibleMembers={controller.setVisibleMembers} onRemoveMember={controller.removeMember}
    onOpenAddMembers={chatList ? () => setAdding(true) : undefined} />;
}

function InfoProgress({ text }: { readonly text: string }) {
  return <div className="chat-info-progress" role="status">
    <AppIcon name="spinner" className="auth-spinner" />
    <span>{text}</span>
  </div>;
}

function InfoError({ error, onRetry, busy = false }: {
  readonly error: ChatInfoError; readonly onRetry?: () => void; readonly busy?: boolean;
}) {
  const { t } = useTranslation('errors'), { t: commonT } = useTranslation('common');
  return <div className="chat-info-error">
    <p role="alert">{t($ => $[error.messageCode])}</p>
    {error.retryable && onRetry && <button type="button" className="glass-control chat-info-retry" disabled={busy} onClick={onRetry}>{commonT($ => $.retry)}</button>}
  </div>;
}

function PersonalPresence({ presence }: { readonly presence: ConversationPresence }) {
  const { t, i18n } = useTranslation('chatInfo');
  let text = t($ => $.presence.unknown);
  if (presence.state === 'online') text = t($ => $.presence.online);
  else if (presence.state === 'offline') {
    text = t($ => $.presence.offline);
    const date = presence.lastSeenAt ? new Date(presence.lastSeenAt) : undefined;
    if (date && Number.isFinite(date.getTime())) text = t($ => $.presence.lastSeen, {
      dateTime: new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, { dateStyle: 'short', timeStyle: 'short' }).format(date),
    });
  }
  return <p className={'chat-info-presence' + (presence.state === 'online' ? ' is-online' : '')}>{text}</p>;
}

export function ChatInfoMuteRow({ mute, allowed, refreshing, onSetMuted }: {
  readonly mute: ChatInfoMuteState;
  readonly allowed: boolean;
  readonly refreshing: boolean;
  readonly onSetMuted: (muted: boolean) => Promise<void>;
}) {
  const { t } = useTranslation('chatInfo');
  const labelId = useId(), detailId = useId();
  const muted = mute.state === 'unknown' ? undefined
    : mute.state === 'confirmed' ? mute.muted : mute.previous;
  const saving = mute.state === 'saving';
  const error = mute.state === 'failed' || mute.state === 'reconciling' ? mute.error : undefined;
  const disabled = !allowed || error?.retryable === false;
  return <section className="chat-info-notifications" aria-labelledby={labelId}>
    <div className="settings-row">
      <span id={labelId}>{t($ => $.mute.label)}</span>
      <SettingsSwitch checked={muted} labelId={labelId} descriptionId={error ? detailId : undefined}
        disabled={disabled} readOnly={refreshing} busy={saving}
        onChange={next => { void onSetMuted(next); }} />
    </div>
    {error && <div id={detailId} className="chat-info-mute-feedback">
      <InfoError error={error} />
    </div>}
  </section>;
}

const noMembers = Object.freeze([]);
const ignoreVisibleMembers = (_uids: readonly string[]) => {};

function GroupMembers({ state, onRetry, busy, onVisible, isChannel, ownUid, canManage, onRemove, onAdd }: {
  readonly isChannel: boolean; readonly state: ChatInfoMembersState; readonly onRetry: () => void; readonly busy: boolean;
  readonly onVisible: (uids: readonly string[]) => void;
  readonly ownUid: string;
  readonly canManage: boolean;
  readonly onRemove: (uid: string) => Promise<ChatInfoError | undefined>;
  readonly onAdd?: () => void;
}) {
  const { t, i18n } = useTranslation('chatInfo'), { t: commonT } = useTranslation('common');
  const loaded = state.state === 'ready' || state.state === 'partial' || state.state === 'available' ? state
    : state.state === 'loading' || state.state === 'failed' ? state.lastKnown : undefined;
  const members = loaded ? [...loaded.members].sort((first, second) =>
    Number(second.ownership.state === 'owner') - Number(first.ownership.state === 'owner'),
  ) : noMembers;
  const list = useVisibleMembers(members, onVisible), labelId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [removal, setRemoval] = useState<{ id: string; name: string; trigger: HTMLButtonElement }>();
  const removable = canManage && loaded === state
    ? new Set(members.filter(member => member.uid !== ownUid && member.removable).map(member => member.uid))
    : undefined;
  const numbers = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language);
  const error = state.state === 'failed' || state.state === 'unavailable' ? state.error : undefined;
  return <section className="chat-info-members" aria-labelledby={labelId} aria-busy={busy || state.state === 'loading'}>
    {canManage && onAdd && <button type="button" className="glass-control chat-info-add-member" disabled={busy} onClick={onAdd}>
      {t($ => $.members.addLabel)}
    </button>}
    <h2 ref={heading} id={labelId} tabIndex={-1} className="settings-list-heading chat-info-members-heading">
      {isChannel ? t($ => $.members.channelTitle) : t($ => $.members.title)}
      {loaded && (isChannel ? <span>{numbers.format(members.length)}</span>
        : loaded.totalCount.state === 'known' && <span>{numbers.format(loaded.totalCount.value)}</span>)}
    </h2>
    {members.length > 0 && <SettingsPeopleList listRef={list} people={members.map(member => ({
      id: member.uid,
      name: member.displayName.state === 'known' ? member.displayName.text : t($ => $.members.unknownName),
      avatar: member.avatar,
      badge: member.ownership.state === 'owner' ? t($ => $.members.owner) : undefined,
    }))} renderAction={({ id, name }) => removable?.has(id) && <button type="button" className="chat-info-remove-member"
      aria-label={t($ => $.members.removeLabel, { name })} disabled={busy}
      onClick={event => setRemoval({ id, name, trigger: event.currentTarget })}>
      <AppIcon name="trash" />
    </button>} />}
    {(state.state === 'ready' || state.state === 'available') && members.length === 0 && <p className="chat-info-members-note" role="status">{isChannel ? t($ => $.members.noneAvailable) : t($ => $.members.empty)}</p>}
    {loaded?.state === 'partial' && <div className="chat-info-members-partial">
      <p className="chat-info-members-note" role="status">{loaded.totalCount.state === 'known'
        ? t($ => $.members.partialCount, { shown: numbers.format(members.length), total: numbers.format(loaded.totalCount.value) })
        : t($ => $.members.partial)}</p>
      {!error && <button type="button" className="glass-control chat-info-retry" disabled={busy} onClick={onRetry}>{commonT($ => $.retry)}</button>}
    </div>}
    {state.state === 'loading' && <InfoProgress text={t($ => $.members.loading)} />}
    {state.state === 'unavailable' && state.reason === 'unsupported'
      ? <p className="chat-info-members-note" role="status">{t($ => $.members.unsupported)}</p>
      : error && <InfoError error={error} onRetry={onRetry} busy={busy} />}
    {removal && <MemberRemovalDialog name={removal.name} trigger={removal.trigger} fallback={heading.current}
      onClose={() => setRemoval(undefined)} onConfirm={() => onRemove(removal.id)} />}
  </section>;
}

// Missing essential details use the same error message and retry action as a failed load.
// A missing photo, online status, or permissions alone does not make the profile invalid.
const unavailableDetails: ChatInfoError = Object.freeze({
  kind: 'unavailable', area: 'details', messageCode: 'chatInfoNetwork', retryable: true,
});

export interface ChatInfoScreenProps {
  readonly snapshot: ChatInfoSnapshot;
  readonly onBack: () => void;
  readonly onRetry: () => void;
  readonly onSetMuted: (muted: boolean) => Promise<void>;
  readonly onSaveGroup: (patch: ChatInfoGroupPatch) => Promise<ChatInfoGroupSaveResult | undefined>;
  readonly onCheckGroupSave: () => Promise<ChatInfoGroupSaveResult | undefined>;
  readonly maxMessageSize?: ServerLimit;
  readonly onVisibleMembers?: (uids: readonly string[]) => void;
  readonly onRemoveMember: (uid: string) => Promise<ChatInfoError | undefined>;
  readonly onOpenAddMembers?: () => void;
}

export function ChatInfoScreen({ snapshot, onBack, onRetry, onSetMuted, onSaveGroup, onCheckGroupSave, maxMessageSize, onVisibleMembers = ignoreVisibleMembers, onRemoveMember, onOpenAddMembers }: ChatInfoScreenProps) {
  const { t, i18n } = useTranslation('chatInfo');
  const { t: commonT } = useTranslation('common');
  const titleId = useId();
  const screen = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState(false);
  const data = snapshot.phase === 'ready' ? snapshot.data : snapshot.phase === 'failed' ? snapshot.lastKnown : undefined;
  const seed = snapshot.phase === 'idle' || snapshot.phase === 'loading' || snapshot.phase === 'failed' ? snapshot.seed : undefined;
  const details = data ?? seed;
  const validDetails = details?.kind === snapshot.identity.kind ? details : undefined;
  const personal = validDetails?.kind === 'personal' ? validDetails : undefined;
  const group = validDetails?.kind === 'group' ? validDetails : undefined;
  const name = validDetails?.title.state === 'known' ? validDetails.title.text : undefined;
  const pending = snapshot.phase === 'idle' || snapshot.phase === 'loading';
  const refreshing = snapshot.phase === 'ready' && snapshot.refresh.state === 'pending';
  const canEdit = snapshot.phase === 'ready' && data?.kind === 'group' &&
    snapshot.identity.topicKey.startsWith('grp') && data.permissions.canEditGroup.state === 'allowed';
  const isEditing = canEdit && editing;
  useSettingsEditorKeyboard(screen, isEditing);
  if (editing && !canEdit) setEditing(false);
  const save = snapshot.phase === 'ready' ? snapshot.groupSave : undefined;
  const saving = save?.state === 'saving' || save?.state === 'checking';
  const removing = snapshot.phase === 'ready' && snapshot.removingMember !== undefined;
  const canManage = snapshot.phase === 'ready' && data?.kind === 'group' &&
    canManageChatInfoMembers(snapshot.identity, data.permissions.ownAccess);
  const error = snapshot.phase === 'failed' ? snapshot.error
    : snapshot.phase === 'ready' && snapshot.refresh.state === 'failed' ? snapshot.refresh.error
      : snapshot.phase === 'ready' && !refreshing && !name && !canEdit ? unavailableDetails : undefined;
  return <section ref={screen} className="settings-screen chat-info-screen" aria-labelledby={titleId}>
    <style>{chatInfoStyles}</style>
    <SettingsHeader title={t($ => $.title)} titleId={titleId} onBack={onBack}
      action={isEditing ? { label: commonT($ => $.cancel), onClick: () => setEditing(false) }
        : canEdit ? { label: t($ => $.edit.action), disabled: saving, onClick: () => setEditing(true) } : undefined} />
    <div className="chat-info-content">
      {validDetails && (name || canEdit) && <>
        <div className={"chat-info-hero" + (group ? " is-group" : "")}>
          {isEditing ? <GroupEditor name={name ?? ''} avatar={validDetails.avatar} topicKey={snapshot.identity.topicKey}
            maxMessageSize={maxMessageSize} busy={refreshing || data?.mute.state === 'saving'}
            operation={save} onSave={onSaveGroup} onCheck={onCheckGroupSave}
            onConfirmed={() => setEditing(false)} /> : <>
            <SettingsAvatar avatar={validDetails.avatar} name={name ?? ''} />
            {personal && <PersonalPresence presence={personal.presence ?? { state: 'unknown' }} />}
            <h2 className="chat-info-name">{name}</h2>
          </>}
          {group?.isChannel && <p className="chat-info-presence">{group.participantCount?.state === 'known'
            ? t($ => $.subscribers, { count: group.participantCount.value,
              value: new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language).format(group.participantCount.value) }) : t($ => $.channel)}</p>}
        </div>
        <ChatInfoMuteRow mute={data?.mute ?? { state: 'unknown' }}
          allowed={snapshot.phase === 'ready' && data?.permissions.canChangeMute.state === 'allowed'}
          refreshing={refreshing || saving || removing} onSetMuted={onSetMuted} />
      </>}
      {pending && <InfoProgress text={t($ => $.loading)} />}
      {refreshing && <InfoProgress text={t($ => $.refreshing)} />}
      {error && <InfoError error={error} onRetry={onRetry} busy={refreshing} />}
      {group && (name || canEdit) && data?.kind === 'group' && <GroupMembers state={data.members} isChannel={data.isChannel === true} onRetry={onRetry}
        busy={refreshing || saving || removing || data.mute.state === 'saving'} onVisible={onVisibleMembers}
        ownUid={snapshot.identity.account.uid} canManage={canManage} onRemove={onRemoveMember} onAdd={onOpenAddMembers} />}
      {snapshot.phase === 'closed' && <p className="chat-info-empty" role="status">{t($ => $.closed)}</p>}
    </div>
  </section>;
}
