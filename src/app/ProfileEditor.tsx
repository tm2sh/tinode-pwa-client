import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isProfileName } from '../profile/own-profile-patch';
import type { ConfirmedOwnProfile, OwnProfilePatch, OwnProfilePort, OwnProfileSaveResult } from '../profile/own-profile-types';
import { SettingsAvatarPicker } from './settings/SettingsAvatarPicker';

interface ProfileEditorProps {
  readonly profile: ConfirmedOwnProfile;
  readonly openPort: () => Promise<OwnProfilePort>;
  readonly onConfirmed: (result: Extract<OwnProfileSaveResult, { state: 'confirmed' }>) => void;
}

type Problem = Extract<OwnProfileSaveResult, { state: 'rejected' }>['reason'] | 'unknown';

export function ProfileEditor({ profile, openPort, onConfirmed }: ProfileEditorProps) {
  const { t } = useTranslation('profile'), { t: commonT } = useTranslation('common'), { t: errorT } = useTranslation('errors');
  const nameId = useId();
  const name = profile.displayName.state === 'known' ? profile.displayName.text : '';
  const [nameDraft, setNameDraft] = useState(name);
  const [avatarDraft, setAvatarDraft] = useState<OwnProfilePatch['avatar']>();
  const [preparing, setPreparing] = useState(false);
  const [port, setPort] = useState<{ instance: OwnProfilePort; maxMessageSize: OwnProfilePort['maxMessageSize'] }>();
  const [openFailed, setOpenFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<'saving' | 'checking'>();
  const [problem, setProblem] = useState<Problem>();
  const request = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const instance = await openPort();
        if (alive) setPort({ instance, maxMessageSize: instance.maxMessageSize });
      } catch {
        if (alive) setOpenFailed(true);
      }
    })();
    return () => {
      alive = false;
      request.current?.abort();
      request.current = undefined;
    };
  }, [openPort, attempt]);

  const nextName = nameDraft.trim();
  const displayName = nextName === name ? undefined : nextName;
  const locked = phase !== undefined || problem === 'unknown';
  const canSave = port && !locked && !preparing && (displayName !== undefined || avatarDraft !== undefined) &&
    (displayName === undefined || isProfileName(displayName));

  async function submit(check: boolean) {
    if (!port || request.current || (check ? problem !== 'unknown' : !canSave)) return;
    const controller = new AbortController();
    request.current = controller;
    setPhase(check ? 'checking' : 'saving');
    setProblem(undefined);
    try {
      const result = check ? await port.instance.checkSave(controller.signal)
        : await port.instance.save({ displayName, avatar: avatarDraft }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.state === 'confirmed') onConfirmed(result);
      else setProblem(result.state === 'rejected' ? result.reason : result.state === 'unknown' ? 'unknown' : 'server');
    } catch {
      if (!controller.signal.aborted) setProblem(check ? 'unknown' : 'server');
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        if (!controller.signal.aborted) setPhase(undefined);
      }
    }
  }

  const remove = avatarDraft?.kind !== 'remove' && (avatarDraft?.kind === 'replace' || profile.avatar.state !== 'missing')
    ? { label: t($ => $.edit.removePhoto), onClick: () => {
      setAvatarDraft(profile.avatar.state === 'missing' ? undefined : { kind: 'remove' });
    } } : undefined;

  return <form className="settings-editor" onSubmit={event => { event.preventDefault(); void submit(false); }}>
    <SettingsAvatarPicker name={nameDraft} avatar={avatarDraft?.kind === 'remove' ? { state: 'missing' } : profile.avatar}
      draft={avatarDraft?.kind === 'replace' ? avatarDraft.prepared : undefined} topicKey="me"
      maxMessageSize={port?.maxMessageSize} disabled={!port || locked} chooseLabel={t($ => $.edit.changePhoto)}
      preparingLabel={t($ => $.edit.preparingPhoto)} errorText={code => errorT($ => $[code])}
      onChoose={prepared => setAvatarDraft({ kind: 'replace', prepared })} onPreparing={setPreparing} remove={remove} />
    <label className="settings-editor-label" htmlFor={nameId}>{t($ => $.edit.name)}</label>
    <input id={nameId} className="settings-editor-name" value={nameDraft} disabled={locked}
      autoComplete="nickname" onChange={event => setNameDraft(event.currentTarget.value)} />
    <button type="submit" className="settings-editor-action settings-editor-save" disabled={!canSave}
      aria-busy={phase === 'saving'}>{phase === 'saving' ? t($ => $.edit.saving) : t($ => $.edit.save)}</button>
    {openFailed && <>
      <p className="settings-editor-error" role="alert">{t($ => $.edit.openFailed)}</p>
      <button type="button" className="settings-editor-action" onClick={() => { setOpenFailed(false); setAttempt(value => value + 1); }}>
        {commonT($ => $.retry)}
      </button>
    </>}
    {problem && <p className="settings-editor-error" role="alert">{t($ => $.edit.errors[problem])}</p>}
    {(problem === 'unknown' || phase === 'checking') &&
      <button type="button" className="settings-editor-action" disabled={phase === 'checking'}
        aria-busy={phase === 'checking'} onClick={() => { void submit(true); }}>
        {phase === 'checking' ? t($ => $.edit.checking) : t($ => $.edit.check)}
      </button>}
  </form>;
}
