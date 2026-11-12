export interface ClientConfig {
  readonly appName: 'Tinode PWA Client';
  readonly host: string;
  readonly secure: true;
  readonly transport: 'ws';
  readonly apiKey: string;
  readonly appBase: string;
  readonly uiLanguage: 'ru' | 'en';
  readonly registrationEnabled: boolean;
  readonly chatCreationEnabled: boolean;
  readonly connectionTimeoutMs: 15000;
}

export type ClientEnvironment = Readonly<Record<string, string | undefined>>;

const sandboxHost = 'sandbox.tinode.co';

// Public application key from https://github.com/tinode/webapp/blob/master/src/config.js.
// This key is separate from user session tokens.
const sandboxApiKey = 'AQEAAAABAAD_rAp4DJh05a1HAwFT3A6K';

function invalidConfiguration(variable: string, expectation: string): never {
  throw new Error('[client-config] ' + variable + ': ' + expectation);
}

function readText(
  environment: ClientEnvironment,
  variable: string,
  fallback?: string,
): string {
  const value = environment[variable] ?? fallback;

  if (typeof value !== 'string' || value.trim() === '') {
    invalidConfiguration(variable, 'Provide a non-empty public value.');
  }

  return value.trim();
}

function readFlag(environment: ClientEnvironment, variable: string): boolean {
  const value = environment[variable];

  if (value === undefined) {
    return true;
  }

  switch (value.trim()) {
    case 'true':
      return true;
    case 'false':
      return false;
    default:
      return invalidConfiguration(variable, 'Use either true or false.');
  }
}

function readHost(environment: ClientEnvironment): string {
  const value = readText(environment, 'VITE_TINODE_HOST', sandboxHost);

  if (/[\s/?#@\\]/.test(value) || value.endsWith(':')) {
    invalidConfiguration(
      'VITE_TINODE_HOST',
      'Use a hostname with an optional port, without a scheme, path, or credentials.',
    );
  }

  try {
    const url = new URL('wss://' + value);

    if (!url.hostname || url.username || url.password || url.pathname !== '/') {
      invalidConfiguration('VITE_TINODE_HOST', 'Use a hostname with an optional port.');
    }

    return url.host;
  } catch {
    return invalidConfiguration(
      'VITE_TINODE_HOST',
      'Use a valid hostname and an optional port.',
    );
  }
}

function readAppBase(environment: ClientEnvironment): string {
  const value = readText(environment, 'VITE_APP_BASE', './');

  if (value === './') {
    return value;
  }

  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\s?#\\]/.test(value) ||
    value.split('/').some((segment) => {
      const decoded = segment.replace(/%2e/gi, '.');
      return decoded === '.' || decoded === '..';
    })
  ) {
    invalidConfiguration(
      'VITE_APP_BASE',
      'Use ./ or a root-relative path such as /tinode-pwa-client/.',
    );
  }

  return value.endsWith('/') ? value : value + '/';
}

function readLanguage(environment: ClientEnvironment): 'ru' | 'en' {
  const language = readText(environment, 'VITE_UI_LANGUAGE', 'ru');
  if (language !== 'ru' && language !== 'en') {
    invalidConfiguration('VITE_UI_LANGUAGE', 'Use either ru or en.');
  }
  return language;
}

export function readClientConfig(environment: ClientEnvironment): Readonly<ClientConfig> {
  const host = readHost(environment);
  const apiKey = readText(
    environment,
    'VITE_TINODE_API_KEY',
    host === sandboxHost ? sandboxApiKey : undefined,
  );

  if (/\s/.test(apiKey)) {
    invalidConfiguration('VITE_TINODE_API_KEY', 'The public key must not contain whitespace.');
  }

  return Object.freeze({
    appName: 'Tinode PWA Client',
    host,
    secure: true,
    transport: 'ws',
    apiKey,
    appBase: readAppBase(environment),
    uiLanguage: readLanguage(environment),
    registrationEnabled: readFlag(environment, 'VITE_REGISTRATION_ENABLED'),
    chatCreationEnabled: readFlag(environment, 'VITE_CHAT_CREATION_ENABLED'),
    connectionTimeoutMs: 15000,
  });
}
