import type { TFunction } from 'i18next';
import type { AuthError } from '../auth/auth-types';

export function authErrorText(t: TFunction<'errors'>, error: AuthError): string {
  const parameters = { serverCode: error.serverCode, seconds: error.messageParams?.seconds };
  const causeCode = error.causeCode;
  const reason = causeCode ? t(($) => $[causeCode], parameters) : undefined;
  return t(($) => $[error.messageCode], { ...parameters, reason });
}
