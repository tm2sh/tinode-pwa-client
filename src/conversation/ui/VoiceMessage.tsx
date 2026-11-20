import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { AppIcon } from '../../app/AppIcon';
import { useTranslation } from 'react-i18next';
import { VoicePlayback } from '../../media/VoicePlayback';
import type { MediaLease } from '../../media/MediaResources';
import type { ConversationMediaReference, VoiceAttachment } from '../conversation-types';
import '../../styles/voice-message.css';

type VoiceMedia = Extract<ConversationMediaReference, { state: 'available' }>;
export type LoadVoice = (media: VoiceMedia, signal: AbortSignal) => Promise<MediaLease>;
interface VoiceMessageProps {
  readonly voice: VoiceAttachment;
  readonly loadVoice: LoadVoice;
  readonly signal?: AbortSignal;
}
const fallbackWave = [5, 10, 18, 12, 21, 14, 7, 17, 11, 22, 15, 8, 19, 13, 6, 16, 22, 12, 7, 17, 10, 20, 13, 8];
function waveform(values: readonly number[] | undefined): readonly number[] {
  const valid = values?.slice(0, 160).filter(value => Number.isFinite(value) && value >= 0 && value <= 255);
  if (!valid?.length) return fallbackWave;
  return fallbackWave.map((_, index) => {
    const start = Math.floor(index * valid.length / 24), end = Math.max(start + 1, Math.floor((index + 1) * valid.length / 24));
    return 3 + Math.max(...valid.slice(start, end)) / 255 * 19;
  });
}
function clock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000)), minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0')
    : minutes + ':' + String(seconds % 60).padStart(2, '0');
}
export function VoiceMessage({ voice, loadVoice, signal }: VoiceMessageProps) {
  const { t } = useTranslation('media'), { t: errorT } = useTranslation('errors');
  const media = voice.media, durationMs = voice.durationMs.state === 'known' ? voice.durationMs.value : undefined;
  const player = useMemo(() => new VoicePlayback({ resourceId: media.state === 'available' ? media.resourceId : '',
    mime: voice.mime, durationMs, acquire: abort => media.state === 'available' ? loadVoice(media, abort) : Promise.reject() }, { signal }),
  [media, voice.mime, durationMs, loadVoice, signal]);
  const state = useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
  // stop() is reusable during StrictMode's effect replay and releases every resource.
  useLayoutEffect(() => () => player.stop(), [player]);
  const wave = useMemo(() => waveform(voice.waveform), [voice.waveform]);
  const playing = state.phase === 'playing', loading = state.phase === 'loading', failed = state.phase === 'error';
  const available = media.state === 'available';
  const total = state.durationMs === undefined ? '—:—' : clock(Math.ceil(state.durationMs / 1000) * 1000);
  const current = clock(state.currentTimeMs);
  const ratio = state.durationMs ? Math.min(1, state.currentTimeMs / state.durationMs) : 0;
  const label = loading ? t($ => $.voice.loading) : playing ? t($ => $.voice.pause) : failed ? t($ => $.voice.retryPlayback) : t($ => $.voice.play);
  return <div className={'conversation-voice-message' + (failed ? ' is-error' : '')}>
    <div className="conversation-voice">
      <button type="button" className="glass-control conversation-voice-play" disabled={!available || signal?.aborted} aria-label={label}
        aria-pressed={playing} aria-busy={loading} onPointerDown={event => event.preventDefault()} onClick={() => {
          if (loading) player.stop(); else if (playing) player.pause(); else void player.play();
        }}>
        {loading ? <AppIcon name="spinner" className="auth-spinner" />
          : <AppIcon name={playing ? 'pause' : 'play'} />}
      </button>
      <div className="conversation-voice-track">
        <div className="conversation-voice-wave" aria-hidden="true">{wave.map((height, index) => <span key={index} style={{ height }} data-active={index / wave.length < ratio} />)}</div>
        <div className="conversation-voice-duration" aria-label={t($ => $.voice.position, { current, duration: total })}>
          {state.currentTimeMs > 0 ? current + ' / ' + total : total}
        </div>
      </div>
    </div>
    {(!available || failed) && <small className="conversation-voice-error" role="alert">{failed ? errorT($ => $[state.error.messageCode]) : errorT($ => $.conversationVoiceLoadFailed)}</small>}
  </div>;
}
