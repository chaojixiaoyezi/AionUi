import React, { useEffect, useState } from 'react';
import { Button, Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, syncPendingLanguage } from '@/renderer/services/i18n';
import styles from './LanguageToggle.module.css';

/** Shared, keyboard-accessible language shortcut for login and workbench chrome. */
const LanguageToggle: React.FC<{ syncOnMount?: boolean }> = ({ syncOnMount = false }) => {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const isChinese = (i18n.resolvedLanguage || i18n.language || '').startsWith('zh');

  useEffect(() => {
    if (syncOnMount) {
      // A failed anonymous save remains local; entering the workbench retries it.
      void syncPendingLanguage().catch(() => {});
    }
  }, [syncOnMount]);

  const handleToggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await changeLanguage(isChinese ? 'en-US' : 'zh-CN');
    } catch {
      Message.warning(t('common.languageSavedLocally'));
    } finally {
      setBusy(false);
    }
  };

  const actionLabel = t(isChinese ? 'common.switchToEnglish' : 'common.switchToChinese');
  return (
    <Button
      htmlType='button'
      size='small'
      shape='round'
      className={styles.toggle}
      onClick={() => void handleToggle()}
      disabled={busy}
      aria-label={actionLabel}
      aria-pressed={isChinese}
      title={actionLabel}
    >
      {t('common.languageToggle')}
    </Button>
  );
};

export default LanguageToggle;
