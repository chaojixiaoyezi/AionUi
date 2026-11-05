import { describe, expect, it } from 'vitest';
import { scryptSync } from 'node:crypto';
import { loadMyAgentConfig } from '../../../packages/web-host/src/myagent/config';
import { verifyPasswordRecord } from '../../../packages/web-host/src/myagent/auth';

// Synthetic fixture only. This is never a deployed user's credential.
const password = 'fixture-only-not-a-real-password';
const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const record = {
  schema: 'admin_password.v1', algorithm: 'scrypt', n: 16384, r: 8, p: 1,
  salt: salt.toString('base64'),
  hash: scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64'),
  updated_at: 1,
};

describe('my-agent native administrator authentication', () => {
  it('accepts the native Python scrypt parameters and Unicode-safe password bytes', async () => {
    expect(await verifyPasswordRecord(password, record)).toBe(true);
  });
  it('rejects a wrong password without changing the native record', async () => {
    expect(await verifyPasswordRecord('incorrect-fixture-password', record)).toBe(false);
  });
  it.each([
    null, {}, { ...record, schema: 'wrong' }, { ...record, algorithm: 'plaintext' },
    { ...record, n: 3 }, { ...record, n: 2 ** 30 }, { ...record, r: 0 },
    { ...record, hash: 'malformed===' }, { ...record, updated_at: Number.NaN },
  ])('fails closed for invalid or resource-exhausting records (%j)', async (invalid) => {
    expect(await verifyPasswordRecord(password, invalid)).toBe(false);
  });
  it('defaults to the exact Gateway and Broker URLs from the task contract', () => {
    expect(loadMyAgentConfig({})).toMatchObject({
      gatewayUrl: 'http://127.0.0.1:8421', brokerUrl: 'http://127.0.0.1:8430',
      cliBin: 'my-agent', adminUsername: 'admin',
    });
  });
  it('honors explicit deployment overrides and credential file references', () => {
    expect(loadMyAgentConfig({ MY_AGENT_GATEWAY_URL: 'http://192.168.1.10:8421',
      MY_AGENT_BROKER_URL: 'http://127.0.0.1:8430', MY_AGENT_CLI_BIN: '/opt/bin/my-agent.code',
      MY_AGENT_GATEWAY_TOKEN_FILE: '/run/credentials/unit/gateway-token',
      MY_AGENT_ADMIN_PASSWORD_FILE: '/run/credentials/unit/admin-password',
    })).toMatchObject({ gatewayUrl: 'http://192.168.1.10:8421', cliBin: '/opt/bin/my-agent.code',
      gatewayTokenFile: '/run/credentials/unit/gateway-token', adminPasswordFile: '/run/credentials/unit/admin-password' });
  });
  it('refuses credential-bearing URLs rather than leaking them through transport errors', () => {
    expect(() => loadMyAgentConfig({ MY_AGENT_GATEWAY_URL: 'http://username:fixture@localhost:8421' })).toThrow();
  });
});
