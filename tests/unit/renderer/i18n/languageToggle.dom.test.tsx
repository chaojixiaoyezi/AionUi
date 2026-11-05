import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { createInstance } from 'i18next';
import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zhCN from '@/renderer/services/i18n/locales/zh-CN';
import enUS from '@/renderer/services/i18n/locales/en-US';

const platform = vi.hoisted(() => ({ mobile: false }));
const sync = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const instance = createInstance();
vi.mock('@/renderer/services/i18n', () => ({
  changeLanguage: (language: string) => instance.changeLanguage(language),
  syncPendingLanguage: sync,
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/guid', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/common', () => ({ ipcBridge: { conversation: { get: { invoke: vi.fn() } } } }));
vi.mock('@/common/config/constants', () => ({ TEAM_MODE_ENABLED: false }));
vi.mock('@renderer/pages/conversation/GroupedHistory/ConversationSearchPopover', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/MobileConversationBrand', () => ({ default: () => null }));
vi.mock('@renderer/components/layout/AppLoader', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/WindowControls', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: platform.mobile }) }));
vi.mock('@/renderer/hooks/context/NavigationHistoryContext', () => ({ useNavigationHistory: () => null }));
vi.mock('@/renderer/hooks/context/FeedbackContext', () => ({ useFeedback: () => ({ openFeedback: vi.fn() }) }));
vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ status: 'unauthenticated', login: vi.fn() }),
}));
vi.mock('@/renderer/services/feedback/resolveFeedbackModule', () => ({
  resolveFeedbackModule: () => 'conversation-session',
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => false, isMacOS: () => false }));

import LoginPage from '@/renderer/pages/login';
import Titlebar from '@/renderer/components/layout/Titlebar';
import LanguageToggle from '@/renderer/components/layout/Titlebar/LanguageToggle';

beforeEach(async () => {
  platform.mobile = false;
  sync.mockClear();
  await instance.init({
    lng: 'zh-CN',
    fallbackLng: 'en-US',
    resources: {
      'zh-CN': { translation: zhCN },
      'en-US': { translation: enUS },
    },
  });
});
afterEach(cleanup);

describe('visible language toggle', () => {
  it('is visible on both the login page and workbench titlebar', () => {
    render(
      <I18nextProvider i18n={instance}>
        <Titlebar workspaceAvailable={false} />
        <LoginPage />
      </I18nextProvider>
    );
    expect(screen.getAllByRole('button', { name: '切换到 English' })).toHaveLength(2);
    expect(screen.getAllByText('🌐 中文 / EN')).toHaveLength(2);
  });

  it('switches the live login copy in either direction without submitting the form', async () => {
    render(
      <I18nextProvider i18n={instance}>
        <LoginPage />
      </I18nextProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: '切换到 English' }));
    await waitFor(() => expect(screen.getByLabelText('Username')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Switch to 中文' }));
    await waitFor(() => expect(screen.getByLabelText('用户名')).toBeInTheDocument());
  });

  it('remains visible in the mobile workbench titlebar', () => {
    platform.mobile = true;
    render(
      <I18nextProvider i18n={instance}>
        <Titlebar workspaceAvailable={false} />
      </I18nextProvider>
    );
    expect(screen.getByRole('button', { name: '切换到 English' })).toBeVisible();
  });

  it('retries a locally saved choice when entering the authenticated workbench', async () => {
    render(
      <I18nextProvider i18n={instance}>
        <LanguageToggle syncOnMount />
      </I18nextProvider>
    );
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  });

  it('does not retry authenticated settings from the anonymous login page', async () => {
    await act(async () => {
      render(
        <I18nextProvider i18n={instance}>
          <LanguageToggle />
        </I18nextProvider>
      );
    });
    expect(sync).not.toHaveBeenCalled();
  });
});
