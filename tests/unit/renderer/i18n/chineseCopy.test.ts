import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '@/common/config/i18n-config.json';
import common from '@/renderer/services/i18n/locales/zh-CN/common.json';
import conversation from '@/renderer/services/i18n/locales/zh-CN/conversation.json';
import team from '@/renderer/services/i18n/locales/zh-CN/team.json';

const locales = new URL('../../../../packages/desktop/src/renderer/services/i18n/locales/', import.meta.url);

describe('Chinese coding workspace copy', () => {
  it('translates generic actions without translating product or Git status names', () => {
    expect(common.copyFailed).toBe('复制失败');
    expect(conversation.commandQueue.actionMode).toBe('选择发送方式');
    expect(conversation.workspace.openWith.vscode).toBe('VS Code');
  });

  it('uses Chinese for the agent selector and skills marketplace', () => {
    expect(conversation.dropdown.cliAgents).toBe('命令行智能体');
    expect(conversation.welcome.skillsMarket).toBe('AionUi 技能市场');
  });

  it('uses Chinese for the team leader role', () => {
    expect(team.create.teamLeader).toBe('团队负责人');
    expect(team.create.leaderLegend).toBe('= 负责人');
    expect(team.warmup.leaderSuffix).toBe('（负责人）');
  });

  it.each(config.supportedLanguages)('ships toggle and my-agent copy in %s', (language) => {
    const commonCopy = JSON.parse(readFileSync(new URL(`${language}/common.json`, locales), 'utf8'));
    const agentCopy = JSON.parse(readFileSync(new URL(`${language}/agent.json`, locales), 'utf8'));
    for (const key of ['languageToggle', 'switchToChinese', 'switchToEnglish', 'languageSavedLocally']) {
      expect(commonCopy[key], `${language}/common.${key}`).toBeTypeOf('string');
      expect(commonCopy[key].trim()).not.toBe('');
    }
    expect(agentCopy.myAgent, `${language}/agent.myAgent`).toBe('my-agent');
    expect(agentCopy.myAgentDescription, `${language}/agent.myAgentDescription`).toBeTypeOf('string');
  });
});
