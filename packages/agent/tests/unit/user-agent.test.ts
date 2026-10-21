import { SDK_METADATA } from '@openrouter/sdk/lib/config';
import { describe, expect, it } from 'vitest';
import { AGENT_USER_AGENT } from '../../src/lib/user-agent.js';
import { PACKAGE_VERSION } from '../../src/mcp/version.js';

describe('AGENT_USER_AGENT', () => {
  it('composes the SDK and Agent package versions', () => {
    expect(AGENT_USER_AGENT).toBe(`${SDK_METADATA.userAgent} @openrouter/agent/${PACKAGE_VERSION}`);
    expect(AGENT_USER_AGENT.startsWith('speakeasy-sdk/typescript ')).toBe(true);
    expect(AGENT_USER_AGENT).toMatch(/ @openrouter\/agent\/\d+\.\d+\.\d+$/u);
  });
});
