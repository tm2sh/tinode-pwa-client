import type addContact from '../locales/ru/addContact.json';
import type createGroup from '../locales/ru/createGroup.json';
import type auth from '../locales/ru/auth.json';
import type chat from '../locales/ru/chat.json';
import type chatInfo from '../locales/ru/chatInfo.json';
import type chatCreation from '../locales/ru/chatCreation.json';
import type chats from '../locales/ru/chats.json';
import type common from '../locales/ru/common.json';
import type errors from '../locales/ru/errors.json';
import type media from '../locales/ru/media.json';
import type profile from '../locales/ru/profile.json';

export interface TranslationResources {
  addContact: typeof addContact;
  auth: typeof auth;
  createGroup: typeof createGroup;
  chats: typeof chats;
  chat: typeof chat;
  chatInfo: typeof chatInfo;
  chatCreation: typeof chatCreation;
  common: typeof common;
  errors: typeof errors;
  media: typeof media;
  profile: typeof profile;
}

export type ErrorMessageCode = keyof TranslationResources['errors'];
export type Namespace = keyof TranslationResources;

import type enAddContact from '../locales/en/addContact.json';
import type enCreateGroup from '../locales/en/createGroup.json';
import type enAuth from '../locales/en/auth.json';
import type enChat from '../locales/en/chat.json';
import type enChatInfo from '../locales/en/chatInfo.json';
import type enChatCreation from '../locales/en/chatCreation.json';
import type enChats from '../locales/en/chats.json';
import type enCommon from '../locales/en/common.json';
import type enErrors from '../locales/en/errors.json';
import type enMedia from '../locales/en/media.json';
import type enProfile from '../locales/en/profile.json';
type EnglishResources = {
  createGroup: typeof enCreateGroup;
  addContact: typeof enAddContact;
  chatInfo: typeof enChatInfo;
  chatCreation: typeof enChatCreation;
  auth: typeof enAuth; chat: typeof enChat; chats: typeof enChats; common: typeof enCommon;
  errors: typeof enErrors; media: typeof enMedia; profile: typeof enProfile;
};
type SameKeys<A, B> = A extends string ? B extends string ? true : false
  : [keyof A] extends [keyof B] ? [keyof B] extends [keyof A]
    ? { [K in keyof A]: K extends keyof B ? SameKeys<A[K], B[K]> : false }[keyof A] extends true ? true : false
    : false : false;
type Assert<T extends true> = T;
export type TranslationKeysMatch = Assert<SameKeys<TranslationResources, EnglishResources>>;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: TranslationResources;
    enableSelector: true;
    returnNull: false;
  }
}
