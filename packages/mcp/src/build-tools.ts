import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@openrouter/agent/tool-types';
import { MCPError } from './errors.js';
import { buildResourceTools } from './resource-tools.js';
import type { UnconvertibleSchemaMode } from './schema/json-schema-to-zod.js';
import type { McpToolDef } from './tool-wrapper.js';
import { wrapMcpTool } from './tool-wrapper.js';
import type { ResourcesOption } from './types.js';

export interface BuildToolsOptions {
  client: Client;
  toolDefs: readonly McpToolDef[];
  namePrefix?: string;
  includeTools?: readonly string[];
  excludeTools?: readonly string[];
  schemaMode?: UnconvertibleSchemaMode;
  emitProgress?: boolean;
  signal?: AbortSignal;
  resources?: ResourcesOption;
  /** Whether the server advertised the resources capability. */
  serverHasResources: boolean;
}

function resourcesEnabled(option: ResourcesOption | undefined): boolean {
  if (option === undefined) {
    return true;
  }
  return option === true || (typeof option === 'object' && option !== null);
}

/** Apply allow/deny filters to discovered MCP tool definitions. */
export function filterToolDefs(
  defs: readonly McpToolDef[],
  includeTools?: readonly string[],
  excludeTools?: readonly string[],
): McpToolDef[] {
  const include = includeTools !== undefined ? new Set(includeTools) : undefined;
  const exclude = new Set(excludeTools ?? []);
  return defs.filter((def) => {
    if (include !== undefined && !include.has(def.name)) {
      return false;
    }
    return !exclude.has(def.name);
  });
}

/**
 * Build the full ordered tool list for a handle: filtered + wrapped MCP tools,
 * plus synthetic resource tools when enabled. Throws on a name collision so two
 * tools never silently shadow each other in `callModel`.
 */
export function buildTools(options: BuildToolsOptions): Tool[] {
  const filtered = filterToolDefs(options.toolDefs, options.includeTools, options.excludeTools);

  const wrapOptions = {
    client: options.client,
    ...(options.namePrefix !== undefined && {
      namePrefix: options.namePrefix,
    }),
    ...(options.schemaMode !== undefined && {
      schemaMode: options.schemaMode,
    }),
    ...(options.emitProgress !== undefined && {
      emitProgress: options.emitProgress,
    }),
    ...(options.signal !== undefined && {
      signal: options.signal,
    }),
  };

  const tools: Tool[] = filtered.map((def) => wrapMcpTool(def, wrapOptions));

  if (options.serverHasResources && resourcesEnabled(options.resources)) {
    tools.push(
      ...buildResourceTools({
        client: options.client,
        ...(options.namePrefix !== undefined && {
          namePrefix: options.namePrefix,
        }),
        ...(options.signal !== undefined && {
          signal: options.signal,
        }),
      }),
    );
  }

  assertNoDuplicateNames(tools);
  return tools;
}

function toolName(tool: Tool): string | undefined {
  if ('function' in tool && typeof tool.function.name === 'string') {
    return tool.function.name;
  }
  return undefined;
}

function assertNoDuplicateNames(tools: readonly Tool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = toolName(tool);
    if (name === undefined) {
      continue;
    }
    if (seen.has(name)) {
      throw new MCPError(
        `Duplicate tool name "${name}". Use toolNamePrefix or excludeTools to disambiguate.`,
      );
    }
    seen.add(name);
  }
}
