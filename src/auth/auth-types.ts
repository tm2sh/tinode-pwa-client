import type { ChatPreviewPause } from '../chats/chat-list-types';
import type { ConversationPort } from '../conversation/conversation-types';
import type { ErrorMessageCode } from '../i18n/resources';

export type { ClientConfig } from '../config/client-config';

export type AuthFlow = 'login' | 'registration';

export type AuthOperation =
  | 'getRequirements'
  | 'login'
  | 'register'
  | 'restore'
  | 'confirmEmail'
  | 'logout';

export type AuthField =
  | 'displayName'
  | 'login'
  | 'password'
  | 'passwordRepeat'
  | 'email'
  | 'code';

export type AuthErrorKind =
  | 'validation'
  | 'invalidCredentials'
  | 'serverDenied'
  | 'network'
  | 'timeout'
  | 'restoreRejected'
  | 'sessionChanged'
  | 'confirmationRequired'
  | 'unsupportedCredential'
  | 'storageUnavailable'
  | 'invalidResponse';

// Safe error details for the UI. Keep raw control packets, causes, and secrets out.
// The UI translates the message code instead of displaying raw SDK messages.
export interface AuthError {
  readonly kind: AuthErrorKind;
  readonly messageCode: ErrorMessageCode;
  readonly causeCode?: ErrorMessageCode;
  readonly messageParams?: { readonly seconds?: number };
  readonly retryable: boolean;
  readonly operation?: AuthOperation;
  readonly field?: AuthField;
  readonly serverCode?: number;
}

export interface AuthenticatedIdentity {
  // Taken from the confirmed server response, not from the login entered by the user.
  readonly uid: string;
}

// Contains the session secret and is used by the controller, adapter, and SessionStore.
export interface SessionRecord {
  readonly schemaVersion: 1;
  readonly serverId: string;
  readonly uid: string;
  readonly token: string;
  // Validate the ISO UTC date when reading it.
  readonly expiresAt: string;
}

export interface PendingEmailInfo {
  readonly flow: AuthFlow;
  readonly contactHint?: string;
}

// Internal adapter state. It is not persisted between launches.
export interface PendingEmailChallenge {
  readonly flow: AuthFlow;
  readonly pendingToken: string;
  readonly expiresAt?: string;
  readonly methods: readonly ['email'];
  readonly contactHint?: string;
  readonly generation: number;
}

export type AuthOutcome =
  | {
      readonly kind: 'authenticated';
      readonly identity: AuthenticatedIdentity;
      readonly session: SessionRecord;
    }
  | {
      readonly kind: 'pendingEmail';
      readonly challenge: PendingEmailInfo;
      readonly error?: AuthError;
    };

export interface RegistrationRequirements {
  readonly emailRequired: boolean;
}

// Public UI snapshot without passwords, verification codes, tokens, or SessionRecord.
// The controller picks fields explicitly instead of spreading the internal result.
export type AuthSnapshot =
  | {
      readonly phase: 'checkingSession';
    }
  | {
      readonly phase: 'signedOut';
      readonly flow: 'login';
      readonly error?: AuthError;
    }
  | {
      readonly phase: 'signedOut';
      readonly flow: 'registration';
      readonly requirements?: RegistrationRequirements;
      readonly error?: AuthError;
    }
  | {
      readonly phase: 'loadingRequirements';
      readonly flow: 'registration';
    }
  | {
      readonly phase: 'submitting';
      readonly flow: 'login';
      readonly operation: 'login';
    }
  | {
      readonly phase: 'submitting';
      readonly flow: 'registration';
      readonly operation: 'register';
      readonly requirements: RegistrationRequirements;
    }
  | {
      readonly phase: 'pendingEmail';
      readonly challenge: PendingEmailInfo;
      readonly error?: AuthError;
    }
  | {
      readonly phase: 'confirming';
      readonly challenge: PendingEmailInfo;
    }
  | {
      readonly phase: 'authenticated';
      readonly identity: AuthenticatedIdentity;
      readonly warning?: AuthError & { readonly kind: 'storageUnavailable' };
    }
  | {
      readonly phase: 'restoreError';
      readonly error: AuthError;
    };

export type AuthPhase = AuthSnapshot['phase'];

// Temporary native form values, read only on explicit submission.
export interface LoginCredentials {
  readonly login: string;
  readonly password: string;
}


// UI contract for email confirmation, without the SDK, temporary token, or full session.
export interface EmailStepProps {
  readonly challenge: PendingEmailInfo;
  readonly busy?: boolean;
  readonly error?: AuthError;
  readonly onSubmit?: (code: string) => void | Promise<void>;
  readonly onEdit?: () => void;
}


// Temporary registration values, kept out of application state and independent of the SDK.
export interface RegistrationRequest {
  readonly displayName: string;
  readonly login: string;
  readonly password: string;
  readonly email?: string;
}

export interface RegistrationCredentials extends RegistrationRequest {
  readonly passwordRepeat: string;
}

export interface RegistrationFormProps {
  readonly emailRequired: boolean;
  readonly preparing?: boolean;
  readonly submissionBlocked?: boolean;
  readonly onRetryRequirements?: () => void | Promise<void>;
  readonly busy?: boolean;
  readonly error?: AuthError;
  readonly onSubmit?: (credentials: RegistrationCredentials) => void | Promise<void>;
  readonly onBack: () => void;
  readonly onEdit?: () => void;
}

// A child port for the current session. Credentials and the SDK stay out of the UI.
export type OpenConversationPort = (topicKey: string, handoff: ChatPreviewPause) => Promise<ConversationPort>;
