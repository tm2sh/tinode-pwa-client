import { createInstance } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { use, useLayoutEffect } from 'react';
import ruCommon from '../locales/ru/common.json';
import ruAuth from '../locales/ru/auth.json';
import ruErrors from '../locales/ru/errors.json';
import enCommon from '../locales/en/common.json';
import enAuth from '../locales/en/auth.json';
import enErrors from '../locales/en/errors.json';
import { languageStorageKey, readStartupLanguage } from './language-preference';
import type { AppLanguage } from './language-preference';
import type { Namespace } from './resources';

type ScreenNamespace = Exclude<Namespace, 'common' | 'auth' | 'errors'>;

// Use JSON assets so a failed network request can be retried in the same document.
const dictionaryUrls = import.meta.glob<string>([
  '../locales/*/chat.json', '../locales/*/chatInfo.json', '../locales/*/chats.json',
  '../locales/*/profile.json', '../locales/*/media.json', '../locales/*/chatCreation.json', '../locales/*/addContact.json', '../locales/*/createGroup.json',
], { eager: true, query: '?url&no-inline', import: 'default' });

const startupLanguage = readStartupLanguage(languageStorageKey);
document.documentElement.lang = startupLanguage;

export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: startupLanguage,
  supportedLngs: ['ru', 'en'],
  fallbackLng: false,
  load: 'currentOnly',
  ns: ['common', 'auth', 'errors'],
  defaultNS: 'common',
  resources: {
    ru: { common: ruCommon, auth: ruAuth, errors: ruErrors },
    en: { common: enCommon, auth: enAuth, errors: enErrors },
  },
  initAsync: false,
  returnNull: false,
  interpolation: { escapeValue: false },
});

interface DictionaryRequest {
  readonly promise: Promise<void>;
  failed: boolean;
}

const dictionaryRequests = new Map<string, DictionaryRequest>();
const dictionaryReady = Promise.resolve();
const activeNamespaces = new Map<ScreenNamespace, number>();
let languageRequest = 0;

function currentLanguage(): AppLanguage {
  return i18n.language === 'ru' ? 'ru' : 'en';
}

function loadDictionary(language: AppLanguage, namespace: ScreenNamespace, retry = false): Promise<void> {
  if (i18n.hasResourceBundle(language, namespace)) return dictionaryReady;
  const key = language + ':' + namespace;
  const pending = dictionaryRequests.get(key);
  if (pending && (!retry || !pending.failed)) return pending.promise;

  const url = dictionaryUrls['../locales/' + language + '/' + namespace + '.json'];
  const request: DictionaryRequest = {
    failed: false,
    promise: (async () => {
      if (!url) throw new Error('Unknown translation resource.');
      const response = await fetch(url, pending?.failed ? { cache: 'reload' } : undefined);
      if (!response.ok) throw new Error('Translation resource could not be loaded.');
      const dictionary: unknown = await response.json();
      if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) {
        throw new Error('Invalid translation resource.');
      }
      i18n.addResourceBundle(language, namespace, dictionary);
      dictionaryRequests.delete(key);
    })().catch((error: unknown) => {
      request.failed = true;
      throw error;
    }),
  };
  dictionaryRequests.set(key, request);
  return request.promise;
}

export function loadTranslations(namespace: ScreenNamespace, options: { readonly retry?: boolean } = {}): Promise<void> {
  return loadDictionary(currentLanguage(), namespace, options.retry);
}

export function useScreenTranslations(primary: ScreenNamespace, secondary?: ScreenNamespace): void {
  useTranslation('common');
  const language = currentLanguage();
  useLayoutEffect(() => {
    const namespaces = secondary ? [primary, secondary] : [primary];
    for (const ns of namespaces) activeNamespaces.set(ns, (activeNamespaces.get(ns) ?? 0) + 1);
    return () => {
      for (const ns of namespaces) {
        const remaining = (activeNamespaces.get(ns) ?? 1) - 1;
        if (remaining > 0) activeNamespaces.set(ns, remaining);
        else activeNamespaces.delete(ns);
      }
    };
  }, [primary, secondary]);

  const first = loadDictionary(language, primary);
  const second = secondary ? loadDictionary(language, secondary) : dictionaryReady;
  if (first !== dictionaryReady || second !== dictionaryReady) {
    // Keep a stable position for each promise even if its dictionary loads first.
    use(first);
    use(second);
  }
}

export async function changeAppLanguage(language: AppLanguage): Promise<void> {
  const request = ++languageRequest;

  // Navigation may mount another screen while the first dictionaries are loading.
  while (request === languageRequest) {
    const missing = [...activeNamespaces.keys()].filter(ns => !i18n.hasResourceBundle(language, ns));
    if (missing.length === 0) break;
    await Promise.all(missing.map(ns => loadDictionary(language, ns, true)));
  }
  if (request !== languageRequest) return;

  document.documentElement.lang = language;
  if (currentLanguage() !== language) await i18n.changeLanguage(language);
  if (request !== languageRequest) return;
  try {
    window.localStorage.setItem(languageStorageKey, language);
  } catch {
    // Keep the applied language for this run when it cannot be persisted.
  }
}
