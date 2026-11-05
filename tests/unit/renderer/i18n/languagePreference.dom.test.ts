import { createInstance } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  savedLanguage: undefined as string | undefined,
  ready: vi.fn<() => Promise<void>>(),
  set: vi.fn<(key: string, value: string) => Promise<void>>(),
  broadcast: vi.fn(),
  listener: undefined as ((event: { language: string }) => Promise<void>) | undefined,
}));
vi.mock('@/common/config/configService', () => ({
  configService: {
    whenReady: () => backend.ready(),
    get: () => backend.savedLanguage,
    set: (key: string, value: string) => backend.set(key, value),
  },
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    systemSettings: {
      languageChanged: {
        on: (listener: typeof backend.listener) => {
          backend.listener = listener;
        },
      },
      changeLanguage: { invoke: (...args: unknown[]) => backend.broadcast(...args) },
    },
  },
}));

async function boot() {
  const instance = createInstance();
  vi.doMock('i18next', () => ({ default: instance }));
  const module = await import('@/renderer/services/i18n');
  return { instance, module };
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  localStorage.clear();
  delete window.__initialLanguage;
  backend.savedLanguage = undefined;
  backend.listener = undefined;
  backend.ready.mockReset().mockResolvedValue();
  backend.set.mockReset().mockResolvedValue();
  backend.broadcast.mockReset().mockResolvedValue(undefined);
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
});

describe('renderer language preference', () => {
  it('starts and stays in Chinese on a first visit even with an English browser', async () => {
    const { instance } = await boot();
    await vi.waitFor(() => expect(localStorage.getItem('i18nextLng')).toBe('zh-CN'));
    expect(instance.language).toBe('zh-CN');
    expect(instance.t('login.submit')).toBe('登录');
  });

  it('retains a browser choice when the backend has no preference', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');
    localStorage.setItem('i18nextLng', 'en-US');
    const { instance } = await boot();
    await vi.waitFor(() => expect(instance.language).toBe('en-US'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(localStorage.getItem('i18nextLng')).toBe('en-US');
  });

  it('honors an explicitly saved user language rather than imposing Chinese', async () => {
    backend.savedLanguage = 'ja-JP';
    const { instance } = await boot();
    await vi.waitFor(() => expect(instance.language).toBe('ja-JP'));
    expect(localStorage.getItem('i18nextLng')).toBe('ja-JP');
  });

  it('still renders Chinese when browser storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });
    const { instance } = await boot();
    expect(instance.language).toBe('zh-CN');
  });

  it('keeps a login-page choice locally when the user-config API rejects it', async () => {
    backend.savedLanguage = 'zh-CN';
    const { instance, module } = await boot();
    await vi.waitFor(() => expect(localStorage.getItem('i18nextLng')).not.toBeNull());
    backend.set.mockRejectedValueOnce(new Error('401 Unauthorized'));
    await expect(module.changeLanguage('en-US')).rejects.toThrow('401');
    expect(instance.language).toBe('en-US');
    expect(localStorage.getItem('i18nextLng')).toBe('en-US');
  });

  it('persists a successful choice to both browser and user configuration', async () => {
    const { instance, module } = await boot();
    await module.changeLanguage('zh-CN');
    expect(instance.language).toBe('zh-CN');
    expect(localStorage.getItem('i18nextLng')).toBe('zh-CN');
    expect(backend.set).toHaveBeenCalledWith('language', 'zh-CN');
  });

  it('does not overwrite a newer click when startup settings arrive late', async () => {
    let finish!: () => void;
    backend.ready.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    backend.savedLanguage = 'en-US';
    const { instance, module } = await boot();
    await module.changeLanguage('zh-CN');
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(instance.language).toBe('zh-CN');
    expect(localStorage.getItem('i18nextLng')).toBe('zh-CN');
  });

  it('serializes the language PATCH as well as the client preference and ignores an older echo', async () => {
    const { instance, module } = await boot();
    await vi.waitFor(() => expect(localStorage.getItem('i18nextLng')).toBe('zh-CN'));
    let finishPatch!: () => void;
    backend.broadcast.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPatch = resolve;
        })
    );
    let firstFinished = false;
    const first = module.changeLanguage('en-US').then(() => {
      firstFinished = true;
    });
    await vi.waitFor(() => expect(backend.broadcast).toHaveBeenCalledTimes(1));
    const second = module.changeLanguage('zh-CN');
    await vi.waitFor(() => expect(instance.language).toBe('zh-CN'));
    try {
      expect(firstFinished).toBe(false);
      expect(backend.set).toHaveBeenCalledTimes(1);
      await backend.listener?.({ language: 'en-US' });
      expect(instance.language).toBe('zh-CN');
      expect(localStorage.getItem('i18nextLng')).toBe('zh-CN');
    } finally {
      finishPatch();
      await Promise.all([first, second]);
    }
    expect(backend.set.mock.calls.map((call) => call[1])).toEqual(['en-US', 'zh-CN']);
    expect(backend.broadcast.mock.calls.map((call) => call[0].language)).toEqual(['en-US', 'zh-CN']);
  });

  it('retains pending state and retries when client PUT succeeds but language PATCH fails', async () => {
    const { module } = await boot();
    await vi.waitFor(() => expect(localStorage.getItem('i18nextLng')).toBe('zh-CN'));
    backend.broadcast.mockRejectedValueOnce(new Error('PATCH failed'));
    await expect(module.changeLanguage('en-US')).rejects.toThrow('PATCH failed');
    expect(localStorage.getItem('aionui:pending-language')).toBe('en-US');
    await module.syncPendingLanguage();
    expect(localStorage.getItem('aionui:pending-language')).toBeNull();
    expect(backend.broadcast).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a remote choice when an older startup snapshot arrives later', async () => {
    let finish!: () => void;
    backend.ready.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    backend.savedLanguage = 'zh-CN';
    const { instance } = await boot();
    await backend.listener?.({ language: 'en-US' });
    finish();
    // Yield one task so the startup continuation has finished, not a timed delay.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(instance.language).toBe('en-US');
    expect(localStorage.getItem('i18nextLng')).toBe('en-US');
  });
});
