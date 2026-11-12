import type { AuthError, AuthField, RegistrationCredentials, RegistrationRequest, RegistrationRequirements } from './auth-types';
import type { ErrorMessageCode } from '../i18n/resources';

// Check required fields and password confirmation. The server enforces format and length.
export function validateRegistration(
  data: RegistrationRequest | RegistrationCredentials,
  requirements: RegistrationRequirements,
): AuthError | undefined {
  const error = (field: AuthField, messageCode: ErrorMessageCode): AuthError => ({
    kind: 'validation', operation: 'register', field, messageCode, retryable: false,
  });
  if (typeof data.displayName !== 'string' || !data.displayName.trim()) return error('displayName', 'displayNameRequired');
  if (typeof data.login !== 'string' || !data.login.trim()) return error('login', 'loginRequired');
  if (typeof data.password !== 'string' || data.password === '') return error('password', 'passwordRequired');
  // The controller checks the full form and sends the adapter a request without passwordRepeat.
  if ('passwordRepeat' in data) {
    if (typeof data.passwordRepeat !== 'string' || data.passwordRepeat === '') return error('passwordRepeat', 'passwordRepeatRequired');
    if (data.password !== data.passwordRepeat) return error('passwordRepeat', 'passwordMismatch');
  }
  if (requirements.emailRequired && (typeof data.email !== 'string' || !data.email.trim())) return error('email', 'emailRequired');
  return undefined;
}
