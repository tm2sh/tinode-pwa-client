export interface VoiceRecordingFormat {
  readonly mimeType: 'audio/webm;codecs=opus' | 'audio/mp4;codecs=mp4a.40.2';
  readonly container: 'webm' | 'mp4';
  readonly extension: 'webm' | 'm4a';
}

export type VoiceRecordingUnavailableReason =
  'insecureContext' | 'microphoneUnavailable' | 'recorderUnavailable' | 'formatUnavailable';

export type VoiceRecordingCapabilities =
  | { readonly state: 'available'; readonly preferred: VoiceRecordingFormat; readonly formats: readonly VoiceRecordingFormat[] }
  | { readonly state: 'unavailable'; readonly reason: VoiceRecordingUnavailableReason };

const candidates: readonly VoiceRecordingFormat[] = Object.freeze([
  Object.freeze({ mimeType: 'audio/webm;codecs=opus', container: 'webm', extension: 'webm' }),
  Object.freeze({ mimeType: 'audio/mp4;codecs=mp4a.40.2', container: 'mp4', extension: 'm4a' }),
]);

// A positive probe permits trying the native codec; it does not prove a recording
// or playback on another device. This module never opens a stream or asks permission.
export function canPlayVoiceMimeType(mimeType: string): boolean {
  if (typeof mimeType !== 'string' || mimeType.length > 255 || typeof document === 'undefined' ||
    !/^audio\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*codecs=(?:[a-z0-9., _-]+|"[a-z0-9., _-]+"))?$/i.test(mimeType.trim())) return false;
  try {
    const support = document.createElement('audio').canPlayType(mimeType.trim());
    return support === 'probably' || support === 'maybe';
  } catch { return false; }
}

export function getVoiceRecordingCapabilities(): VoiceRecordingCapabilities {
  const unavailable = (reason: VoiceRecordingUnavailableReason): VoiceRecordingCapabilities => Object.freeze({ state: 'unavailable', reason });
  if (globalThis.isSecureContext !== true) return unavailable('insecureContext');
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    return unavailable('microphoneUnavailable');
  }
  if (typeof MediaRecorder !== 'function' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return unavailable('recorderUnavailable');
  }
  const formats = candidates.filter(format => {
    try { return MediaRecorder.isTypeSupported(format.mimeType) && canPlayVoiceMimeType(format.mimeType); }
    catch { return false; }
  });
  if (formats.length === 0) return unavailable('formatUnavailable');
  return Object.freeze({ state: 'available', preferred: formats[0], formats: Object.freeze(formats) });
}
