import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPMissingPeerDependencyError } from '../../../src/mcp/errors.js';

const state = vi.hoisted(() => ({
  error: new Error(),
}));

vi.mock('@modelcontextprotocol/client', () => {
  throw state.error;
});

const { loadMcpSdk } = await import('../../../src/mcp/mcp-sdk.js');

function moduleNotFound(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
}

async function loadError(): Promise<Error> {
  try {
    await loadMcpSdk();
    throw new Error('Expected loadMcpSdk to reject');
  } catch (error) {
    return error as Error;
  }
}

describe('loadMcpSdk missing peer classification', () => {
  beforeEach(() => {
    state.error = new Error();
  });

  it('wraps a missing @modelcontextprotocol/client peer', async () => {
    state.error = moduleNotFound(
      "Cannot find package '@modelcontextprotocol/client' imported from /app/agent.js",
    );

    const error = await loadError();
    expect(error).toBeInstanceOf(MCPMissingPeerDependencyError);
    expect((error.cause as Error).cause).toBe(state.error);
  });

  it('surfaces a missing transitive dependency unchanged', async () => {
    state.error = moduleNotFound(
      "Cannot find package 'eventsource' imported from /app/node_modules/@modelcontextprotocol/client/dist/index.js",
    );

    const error = await loadError();
    expect(error).not.toBeInstanceOf(MCPMissingPeerDependencyError);
    expect(error.cause).toBe(state.error);
  });

  it('wraps a missing @modelcontextprotocol/client subpath', async () => {
    state.error = moduleNotFound(
      "Cannot find module '@modelcontextprotocol/client/streamableHttp' imported from /app/agent.js",
    );

    const error = await loadError();
    expect(error).toBeInstanceOf(MCPMissingPeerDependencyError);
    expect((error.cause as Error).cause).toBe(state.error);
  });
});
