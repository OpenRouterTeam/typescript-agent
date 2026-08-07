import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  throw Object.assign(new Error("Cannot find package '@modelcontextprotocol/sdk'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
});
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  throw Object.assign(new Error("Cannot find package '@modelcontextprotocol/sdk'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
});
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  throw Object.assign(new Error("Cannot find package '@modelcontextprotocol/sdk'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
});
vi.mock('@modelcontextprotocol/sdk/types.js', () => {
  throw Object.assign(new Error("Cannot find package '@modelcontextprotocol/sdk'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
});

describe('optional MCP SDK loading', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does not load the SDK for root, tool-set, or MCP entry-point imports', async () => {
    await expect(import('@openrouter/agent')).resolves.toBeDefined();
    await expect(import('@openrouter/agent/tool-set')).resolves.toBeDefined();
    await expect(import('@openrouter/agent/mcp')).resolves.toBeDefined();
  });

  it('reports an actionable error when the first connection needs the missing peer', async () => {
    const { connect } = await import('../../../src/mcp/mcp-connection.js');
    const { MCPMissingPeerDependencyError } = await import('../../../src/mcp/errors.js');

    const error = await connect({
      url: new URL('https://mcp.example.com/mcp'),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MCPMissingPeerDependencyError);
    expect(error).toMatchObject({
      name: 'MCPMissingPeerDependencyError',
      packageName: '@modelcontextprotocol/sdk',
    });
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('pnpm add @modelcontextprotocol/sdk');
  });
});
