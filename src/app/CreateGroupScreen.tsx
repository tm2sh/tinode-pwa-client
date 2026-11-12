import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isGroupTitle } from '../chat-info/group-public-patch';
import { personalChatContacts } from '../chats/chat-creation-contacts';
import type { ChatListView } from '../chats/chat-list-presenter';
import { groupCreationTopicPrefix } from '../groups/group-creation-packet';
import type { GroupCreationInput, GroupCreationKind, GroupCreationPort, GroupCreationProgress, GroupCreationResult, OpenGroupCreationPort } from '../groups/group-creation-types';
import { useScreenTranslations } from '../i18n';
import type { PreparedAvatar } from '../media/AvatarPreparation';
import { AppIcon } from './AppIcon';
import { ParticipantPicker } from './settings/ParticipantPicker';
import { SettingsAvatarPicker } from './settings/SettingsAvatarPicker';
import { SettingsHeader } from './settings/SettingsHeader';
import { SettingsPeopleList } from './settings/SettingsPeopleList';
import type { SettingsPerson } from './settings/SettingsPeopleList';
import '../styles/create-group.css';

const missingAvatar = { state: 'missing' } as const;

interface CreateGroupScreenProps {
  readonly kind: GroupCreationKind;
  readonly chatList: Pick<ChatListView, 'items' | 'phase'>;
  readonly openPort: OpenGroupCreationPort;
  readonly onRun: (port: GroupCreationPort, input: GroupCreationInput, previous: GroupCreationProgress | undefined, signal: AbortSignal) => Promise<GroupCreationResult>;
  readonly onOpen: (created: Extract<GroupCreationResult, { state: 'created' }>, signal: AbortSignal) => Promise<boolean>;
  readonly onBack: () => void;
}

export function CreateGroupScreen({ kind, chatList, openPort, onRun, onOpen, onBack }: CreateGroupScreenProps) {
  useScreenTranslations('createGroup');
  const { t, i18n } = useTranslation('createGroup');
  const { t: errorT } = useTranslation('errors');
  const isChannel = kind === 'channel';
  const titleId = useId(), nameId = useId();
  const request = useRef<AbortController | undefined>(undefined);
  const [port, setPort] = useState<GroupCreationPort>();
  const [step, setStep] = useState<'people' | 'details'>('people');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlyMap<string, SettingsPerson>>(() => new Map());
  const [title, setTitle] = useState('');
  const [avatar, setAvatar] = useState<PreparedAvatar>();
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GroupCreationResult>();
  const [openFailed, setOpenFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void openPort().then(value => { if (active) setPort(value); }, () => {});
    return () => { active = false; request.current?.abort(); };
  }, [openPort]);

  const language = i18n.resolvedLanguage ?? i18n.language;
  const contacts = useMemo(() => personalChatContacts(chatList.items, language), [chatList.items, language]);
  const selectedIds = new Set(selected.keys());
  const latestContacts = new Map(contacts.map(person => [person.id, person]));
  const selectedPeople = Array.from(selected.values(), person => latestContacts.get(person.id) ?? person);
  const subscriberLimit = port?.subscriberLimit;
  const limitReached = subscriberLimit !== undefined && selected.size + 1 >= subscriberLimit;
  const progress = result && result.state !== 'rejected' ? result : undefined;
  const created = progress?.state === 'created' ? progress : undefined;
  const locked = busy || progress !== undefined;
  const validTitle = isGroupTitle(title.trim());

  const toggle = (id: string) => {
    if (locked) return;
    setSelected(previous => {
      const next = new Map(previous);
      if (next.delete(id)) return next;
      const person = latestContacts.get(id);
      if (person && (subscriberLimit === undefined || previous.size + 1 < subscriberLimit)) next.set(id, person);
      return next;
    });
  };

  const back = () => {
    if (request.current) return;
    if (step === 'details') { setPreparing(false); setStep('people'); }
    else onBack();
  };

  const run = async (openOnly = false) => {
    if (request.current || preparing || (!openOnly && !progress && !validTitle)) return;
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    setBusy(true);
    setOpenFailed(false);
    let confirmed = created;
    try {
      if (!openOnly) {
        const currentPort = port ?? await openPort();
        if (signal.aborted) return;
        if (!port) setPort(currentPort);
        const next = await onRun(currentPort, { kind, title, avatar, participants: [...selected.keys()] }, progress, signal);
        if (signal.aborted) return;
        setResult(next);
        confirmed = next.state === 'created' ? next : undefined;
      }
      if (confirmed && (openOnly || (!confirmed.issues.length && !confirmed.attachmentUncertain))) {
        if (!await onOpen(confirmed, signal) && !signal.aborted) setOpenFailed(true);
      }
    } catch {
      if (signal.aborted) return;
      if (confirmed) setOpenFailed(true);
      else if (!progress) setResult({ state: 'rejected', reason: 'unavailable' });
    } finally {
      if (request.current === controller) request.current = undefined;
      if (!signal.aborted) setBusy(false);
    }
  };

  const heading = t($ => isChannel ? $.channel.title : $.title);
  if (step === 'people') return <ParticipantPicker title={heading} contacts={contacts} phase={chatList.phase}
    query={query} onQuery={setQuery} selected={selectedIds} onToggle={toggle} onBack={back}
    limitReached={limitReached} locked={locked} busy={busy} action={{ label: t($ => $.next), onClick: () => setStep('details') }} />;

  return <section className="chats-screen settings-screen group-create-screen" aria-labelledby={titleId}>
    <SettingsHeader title={heading} titleId={titleId} onBack={back} backDisabled={busy}
      action={{ label: t($ => $.create), disabled: locked || preparing || !validTitle, onClick: () => { void run(); } }} />
    <form className="settings-editor group-create-editor" onSubmit={event => {
      event.preventDefault();
      if (!locked) void run();
    }}>
      <SettingsAvatarPicker name={title.trim() || heading} avatar={missingAvatar} draft={avatar} topicKey={groupCreationTopicPrefix(kind)}
        creationTitle={title.trim()} maxMessageSize={port?.maxMessageSize} disabled={locked || !port}
        chooseLabel={t($ => $.choosePhoto)} preparingLabel={t($ => $.preparingPhoto)} errorText={code => errorT($ => $[code])}
        onChoose={setAvatar} onPreparing={setPreparing}
        remove={avatar ? { label: t($ => $.removePhoto), onClick: () => setAvatar(undefined) } : undefined} />
      <label className="settings-editor-label" htmlFor={nameId}>{t($ => isChannel ? $.channel.name : $.name)}</label>
      <input className="settings-editor-name" id={nameId} required value={title} disabled={locked}
        onChange={event => { setTitle(event.currentTarget.value); setResult(undefined); }} enterKeyHint="done" />
    </form>
    {selectedPeople.length > 0 && <SettingsPeopleList people={selectedPeople} />}
    {busy && <p className="group-create-note group-create-progress" role="status">
      <AppIcon name="spinner" className="auth-spinner" />{t($ => isChannel ? $.channel.working : $.working)}
    </p>}
    {!busy && result?.state === 'rejected' && <p className="settings-editor-error" role="alert">
      {t($ => (isChannel ? $.channel.errors : $.errors)[result.reason])}
    </p>}
    {!busy && progress?.state === 'unconfirmed' && <div className="group-create-result">
      <p className="settings-editor-error" role="alert">{t($ => isChannel ? $.channel.unconfirmed : $.unconfirmed)}</p>
      <button type="button" className="settings-editor-action" onClick={() => { void run(); }}>{t($ => $.check)}</button>
    </div>}
    {!busy && created && (created.issues.length > 0 || created.attachmentUncertain || openFailed) &&
      <div className="group-create-result">
        {created.issues.length > 0 && <div role="alert">
          <p className="settings-editor-error">{t($ => isChannel ? $.channel.invitesIncomplete : $.invitesIncomplete)}</p>
          <ul className="group-create-issues">{created.issues.map(issue => <li key={issue.userId}>
            {selected.get(issue.userId)?.name ?? issue.userId} · {t($ => $.invite[issue.state])}
          </li>)}</ul>
        </div>}
        {(created.attachmentUncertain || openFailed) && <p className="settings-editor-error" role="alert">
          {t($ => isChannel ? $.channel.openFailed : $.openFailed)}
        </p>}
        {created.issues.length > 0 &&
          <button type="button" className="settings-editor-action" onClick={() => { void run(); }}>{t($ => $.retry)}</button>}
        <button type="button" className="settings-editor-action" onClick={() => { void run(true); }}>
          {t($ => isChannel ? $.channel.open : $.open)}
        </button>
      </div>}
  </section>;
}
