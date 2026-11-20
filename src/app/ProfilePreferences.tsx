import { useId, useRef, useState } from 'react';
import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { changeAppLanguage } from '../i18n';
import type { AppLanguage } from '../i18n/language-preference';
import { AppIcon } from './AppIcon';
import { getThemePreference, setThemePreference, themePreferences } from './theme-preference';
import type { ThemePreference } from './theme-preference';

interface PreferenceListProps<Value extends string> {
  readonly title: string;
  readonly options: readonly { value: Value; label: string; lang?: string }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  readonly pending?: boolean;
  readonly listRef?: Ref<HTMLDivElement>;
}

function PreferenceList<Value extends string>({ title, options, selected, onSelect, pending, listRef }: PreferenceListProps<Value>) {
  const id = useId();
  return <section>
    <h2 className="settings-list-heading" id={id}>{title}</h2>
    <div ref={listRef} className="settings-list" role="radiogroup" aria-labelledby={id} aria-busy={pending || undefined}>
      {options.map(({ value, label, lang }) => <label key={value} className="settings-list-row profile-choice">
        <input type="radio" name={id} value={value} checked={value === selected}
          aria-disabled={pending || undefined} onChange={() => onSelect(value)} />
        <span lang={lang}>{label}</span>
        {value === selected && <AppIcon name="check" size={24} />}
      </label>)}
    </div>
  </section>;
}

export function ProfilePreferences() {
  const { t, i18n } = useTranslation('profile');
  const { t: commonT } = useTranslation('common');
  const [theme, setTheme] = useState(getThemePreference);
  const [pending, setPending] = useState(false);
  const [failedLanguage, setFailedLanguage] = useState<AppLanguage>();
  const languageList = useRef<HTMLDivElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const changingLanguage = useRef(false);

  function selectTheme(preference: ThemePreference) {
    setThemePreference(preference);
    setTheme(preference);
  }

  async function selectLanguage(language: AppLanguage) {
    if (changingLanguage.current || i18n.language === language) return;
    changingLanguage.current = true;
    setPending(true);
    try {
      await changeAppLanguage(language);
      if (retryButton.current && document.activeElement === retryButton.current) {
        languageList.current?.querySelector<HTMLInputElement>('input[value="' + language + '"]')?.focus({ preventScroll: true });
      }
      setFailedLanguage(undefined);
    } catch {
      setFailedLanguage(language);
    } finally {
      changingLanguage.current = false;
      setPending(false);
    }
  }

  return <div className="profile-preferences">
    <PreferenceList<ThemePreference> title={t($ => $.appearance.theme.title)} selected={theme} onSelect={selectTheme}
      options={themePreferences.map(value => ({ value, label: t($ => $.appearance.theme[value]) }))} />
    <div>
      <PreferenceList<AppLanguage> title={t($ => $.appearance.language.title)}
        selected={i18n.language === 'ru' ? 'ru' : 'en'} pending={pending} listRef={languageList}
        onSelect={language => { void selectLanguage(language); }}
        options={[
          { value: 'en', label: t($ => $.appearance.language.english), lang: 'en' },
          { value: 'ru', label: t($ => $.appearance.language.russian), lang: 'ru' },
        ]} />
      {pending && <p className="profile-language-status" role="status">{t($ => $.appearance.language.loading)}</p>}
      {failedLanguage && <div className="profile-language-feedback">
        {!pending && <p className="profile-error" role="alert">{t($ => $.appearance.language.failed)}</p>}
        <button ref={retryButton} className="glass-control profile-retry" type="button" aria-disabled={pending || undefined}
          onClick={() => { void selectLanguage(failedLanguage); }}>{commonT($ => $.retry)}</button>
      </div>}
    </div>
  </div>;
}
