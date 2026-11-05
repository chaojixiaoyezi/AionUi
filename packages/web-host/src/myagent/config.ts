export type MyAgentConfig = {
  gatewayUrl: string;
  brokerUrl: string;
  cliBin: string;
  adminUsername: string;
  adminPasswordFile?: string;
  gatewayTokenFile?: string;
  brokerKeyFile?: string;
};

/** Resolve trusted deployment configuration, never browser-supplied URLs. */
export function loadMyAgentConfig(env: NodeJS.ProcessEnv = process.env): MyAgentConfig {
  const endpoint = (value: string, code: string): string => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error(code);
      }
      return url.toString().replace(/\/$/, '');
    } catch {
      throw new Error(code);
    }
  };
  return {
    gatewayUrl: endpoint(env.MY_AGENT_GATEWAY_URL || 'http://127.0.0.1:8421', 'INVALID_MY_AGENT_GATEWAY_URL'),
    brokerUrl: endpoint(env.MY_AGENT_BROKER_URL || 'http://127.0.0.1:8430', 'INVALID_MY_AGENT_BROKER_URL'),
    cliBin: env.MY_AGENT_CLI_BIN || 'my-agent',
    adminUsername: env.MY_AGENT_ADMIN_USERNAME || 'admin',
    adminPasswordFile: env.MY_AGENT_ADMIN_PASSWORD_FILE || undefined,
    gatewayTokenFile: env.MY_AGENT_GATEWAY_TOKEN_FILE || undefined,
    brokerKeyFile: env.MY_AGENT_BROKER_KEY_FILE || undefined,
  };
}
