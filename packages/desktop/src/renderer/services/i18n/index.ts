import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { configService } from '@/common/config/configService';
import { ipcBridge } from '@/common';
import i18nConfig from '@/common/config/i18n-config.json';
import {
  DEFAULT_LANGUAGE,
  normalizeLanguageCode,
  mergeWithFallback,
  ensureAndSwitch,
  type LocaleData,
  type SupportedLanguage,
} from '@/common/config/i18n';
import { applyDocumentDirection } from './direction';

// Static imports for all locales to ensure packaged app can always switch language.
import enUS from './locales/en-US/index';
import zhCN from './locales/zh-CN/index';
import jaJP from './locales/ja-JP/index';
import zhTW from './locales/zh-TW/index';
import koKR from './locales/ko-KR/index';
import trTR from './locales/tr-TR/index';
import ruRU from './locales/ru-RU/index';
import ukUA from './locales/uk-UA/index';
import ptBR from './locales/pt-BR/index';
import deDE from './locales/de-DE/index';
import esES from './locales/es-ES/index';
import frFR from './locales/fr-FR/index';
import faIR from './locales/fa-IR/index';
export type { I18nKey, I18nModule } from './i18n-keys';

// Re-exports
export { normalizeLanguageCode } from '@/common/config/i18n';
export type { SupportedLanguage } from '@/common/config/i18n';

export const supportedLanguages = i18nConfig.supportedLanguages;

// The UI default is independent of the reference/fallback translation language.
const DEFAULT_UI_LANGUAGE = 'zh-CN';
const PENDING_LANGUAGE_KEY = 'aionui:pending-language';
let languageRevision = 0;
let pendingLanguage = readStorage(PENDING_LANGUAGE_KEY);
let persistence: Promise<void> = Promise.resolve();

const localeData: LocaleData = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'ja-JP': jaJP,
  'zh-TW': zhTW,
  'ko-KR': koKR,
  'tr-TR': trTR,
  'ru-RU': ruRU,
  'uk-UA': ukUA,
  'pt-BR': ptBR,
  'de-DE': deDE,
  'es-ES': esES,
  'fr-FR': frFR,
  'fa-IR': faIR,
};

const fallbackLocale = localeData[DEFAULT_LANGUAGE] ?? {};

// Cache for loaded translations
const loadedTranslations = new Map<string, Record<string, unknown>>();

// Pre-populate cache with the synchronously loaded fallback locale
loadedTranslations.set(DEFAULT_LANGUAGE, fallbackLocale as Record<string, unknown>);

function getLocaleModules(locale: string): Record<string, unknown> {
  const normalized = normalizeLanguageCode(locale);
  const modules = localeData[normalized] ?? fallbackLocale;
  if (normalized === DEFAULT_LANGUAGE) return modules;
  return mergeWithFallback(fallbackLocale, modules);
}

function readStorage(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)?.trim() || null;
  } catch {
    return null;
  }
}

function writeLanguageHint(language: string): void {
  try {
    localStorage.setItem('i18nextLng', language);
  } catch {
    // Restricted browser storage must not prevent an in-memory language switch.
  }
}

function setPendingLanguage(language: string | null): void {
  pendingLanguage = language;
  try {
    if (language) localStorage.setItem(PENDING_LANGUAGE_KEY, language);
    else localStorage.removeItem(PENDING_LANGUAGE_KEY);
  } catch {
    // The in-memory pending preference can still be synchronized after login.
  }
}

function getInjectedLanguageHint(): string | null {
  if (typeof window === 'undefined') return null;
  const language = window.__initialLanguage;
  return typeof language === 'string' && language.trim() !== '' ? language : null;
}

function getInitialLanguage(): SupportedLanguage {
  const backendStartupFailed =
    typeof window !== 'undefined' && (window as Window & { __backendStartupFailed?: boolean }).__backendStartupFailed;
  const localStorageLanguage = readStorage('i18nextLng');
  const injectedLanguage = getInjectedLanguageHint();
  const hint = backendStartupFailed
    ? injectedLanguage || localStorageLanguage
    : localStorageLanguage || injectedLanguage;
  return normalizeLanguageCode(pendingLanguage || hint || DEFAULT_UI_LANGUAGE);
}

async function loadLocaleModules(locale: string): Promise<Record<string, unknown>> {
  const normalized = normalizeLanguageCode(locale);
  const cached = loadedTranslations.get(normalized);
  if (cached) return cached;

  const modules = getLocaleModules(normalized);
  loadedTranslations.set(normalized, modules);
  return modules;
}

const initialLanguage = getInitialLanguage();
const initialResources: Record<string, { translation: Record<string, unknown> }> = {
  [DEFAULT_LANGUAGE]: {
    translation: fallbackLocale,
  },
};
if (initialLanguage !== DEFAULT_LANGUAGE) {
  initialResources[initialLanguage] = {
    translation: getLocaleModules(initialLanguage),
  };
}

// Initialize i18n with fallback and initial locale loaded synchronously to avoid FOUC.
// NOTE: We intentionally do NOT use i18next-browser-languagedetector here.
// In WebUI mode the browser's localStorage is on a different origin than the
// Electron renderer, so the detector would read the wrong (or missing) value
// and fall back to navigator.language, causing a language mismatch (Issue #1176).
// Instead, we use localStorage and Electron's injected local config language
// only as hints for the initial render, then let configService be the source of truth.
i18n
  .use(initReactI18next)
  .init({
    resources: initialResources,
    lng: initialLanguage,
    fallbackLng: DEFAULT_LANGUAGE,
    debug: false,
    interpolation: { escapeValue: false },
  })
  .catch((error: Error) => {
    console.error('Failed to initialize i18n:', error);
  });

// Load initial language from configService (single source of truth).
// Wait until configService.whenReady() so we observe the authoritative value
// fetched from the backend rather than the empty cache that exists during
// module load.
async function initLanguage(): Promise<void> {
  const revision = languageRevision;
  try {
    await configService.whenReady();
    // A click made while settings were loading is newer than the startup snapshot.
    if (revision !== languageRevision) return;
    if (pendingLanguage) {
      await syncPendingLanguage();
      return;
    }
    const savedLanguage = configService.get('language');
    const language = normalizeLanguageCode(savedLanguage || getInitialLanguage());
    await ensureAndSwitch(i18n, language, loadLocaleModules);
    writeLanguageHint(language);
  } catch (error) {
    console.error('Failed to initialize language:', error);
  }
}

// Listen for language changes and lazy load translations
i18n.on('languageChanged', async (lang: string) => {
  const normalizedLang = normalizeLanguageCode(lang);
  if (i18n.hasResourceBundle(normalizedLang, 'translation')) return;

  try {
    const translation = await loadLocaleModules(normalizedLang);
    i18n.addResourceBundle(normalizedLang, 'translation', translation, true, true);
  } catch (error) {
    console.error(`Failed to load language ${normalizedLang}:`, error);
  }
});

// Keep <html dir>/<html lang> in step with the app language (fa-IR is RTL).
// Separate listener: the one above early-returns once the bundle is loaded.
i18n.on('languageChanged', (lang: string) => {
  applyDocumentDirection(lang);
});
applyDocumentDirection(initialLanguage);

// Initialize on module load
void initLanguage();

// Listen for language changes broadcast by the main process (from other renderers).
// This enables real-time sync between desktop and WebUI — when one changes language,
// the other updates immediately without requiring a restart.
ipcBridge.systemSettings.languageChanged.on(async ({ language }) => {
  const normalized = normalizeLanguageCode(language);
  // A previous save may echo while a newer local choice is still being saved.
  if (pendingLanguage && pendingLanguage !== normalized) return;
  // Remote choices also invalidate any older startup settings snapshot.
  languageRevision += 1;
  writeLanguageHint(normalized);
  if (i18n.language === normalized) return;
  await ensureAndSwitch(i18n, normalized, loadLocaleModules);
});

/**
 * Retry a locally selected language after login. Serialize writes so a slower
 * earlier save cannot overwrite a newer click, and keep failed saves pending.
 */
export function syncPendingLanguage(): Promise<void> {
  const language = pendingLanguage;
  if (!language) return Promise.resolve();
  const save = persistence
    .catch(() => {})
    .then(async () => {
      if (pendingLanguage !== language) return;
      await configService.set('language', language);
      if (pendingLanguage !== language) return;
      // This is a real PATCH to system settings, not a fire-and-forget notification.
      await ipcBridge.systemSettings.changeLanguage.invoke({ language });
      if (pendingLanguage !== language) return;
      setPendingLanguage(null);
    });
  persistence = save;
  return save;
}

/** Switch immediately and retain the browser preference even before login. */
export async function changeLanguage(lang: string): Promise<void> {
  languageRevision += 1;
  const normalized = normalizeLanguageCode(lang);
  // Record intent before any await so an older echo cannot win during bundle loading.
  writeLanguageHint(normalized);
  setPendingLanguage(normalized);
  await ensureAndSwitch(i18n, normalized, loadLocaleModules);
  await syncPendingLanguage();
}

// Clear translation cache (useful for development/testing)
export function clearTranslationCache(): void {
  loadedTranslations.clear();
}

// Get loaded languages
export function getLoadedLanguages(): string[] {
  return Array.from(loadedTranslations.keys());
}

export default i18n;
