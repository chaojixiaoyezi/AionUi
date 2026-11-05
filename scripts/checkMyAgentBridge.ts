/** Opt-in integration check against an actual my-agent Gateway, never a stub server. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadMyAgentConfig } from '../packages/web-host/src/myagent/config';
import { GatewayClient } from '../packages/web-host/src/myagent/gateway';

let stage = 'models';
async function main(): Promise<void> {
  const client = new GatewayClient(loadMyAgentConfig());
  const conversationId = `aionui-w3-test-${randomUUID()}`;
  const models = await client.models(conversationId);
  assert.ok(Array.isArray(models.profiles) && models.profiles.length > 0, 'real Gateway profiles must be available');
  stage = 'ask';
  const marker = `W3_GATEWAY_${randomUUID().replaceAll('-', '')}`;
  const accepted = await client.ask(conversationId, `This is an authorized adapter integration test. Reply with exactly ${marker}. Do not use tools or change any files.`, randomUUID());
  assert.equal(typeof accepted.request_id, 'string', 'real /ask must return a request_id');
  stage = 'progress-result';
  const response = await client.waitForResult(accepted.request_id as string);
  assert.ok(response.includes(marker), 'real canonical /result must contain the requested marker');
  stage = 'history';
  const history = await client.history(conversationId);
  assert.equal(history.ok, true, 'real /client/history must succeed');
  console.log(JSON.stringify({ status: 'passed', checks: ['real-client-models', 'real-ask-progress-result', 'real-client-history'] }));
}

async function mainDispatch(): Promise<void> {
  if (!process.argv.includes('--acp')) { await main(); return; }
  stage = 'acp';
  const { openBridgeStore } = await import('../packages/web-host/src/myagent/store');
  const { runAcpStdio } = await import('../packages/web-host/src/myagent/acp');
  const dataDir = process.env.AIONUI_MY_AGENT_DATA_DIR || process.env.AIONUI_DATA_DIR;
  if (!dataDir) throw new Error('CORE_DATA_DIR_REQUIRED');
  const store = await openBridgeStore(dataDir);
  const shutdown = () => {
    void store.close().catch(() => undefined).finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    const userId = process.env.AIONUI_USER_ID || '';
    const conversationId = process.env.AIONUI_CONVERSATION_ID || '';
    await runAcpStdio(new GatewayClient(loadMyAgentConfig()), userId && conversationId ? { userId, conversationId, store } : undefined);
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    await store.close();
  }
}

mainDispatch().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'ASSERTION_FAILED';
  console.error(`MY_AGENT_LIVE_CHECK_FAILED stage=${stage} code=${code}`); process.exitCode = 1;
});
