import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { isJsonSchemaObject } from './schema/json-schema-guards.js';
import type { ElicitationHandler } from './types.js';

/** Primitive value types the MCP elicitation result `content` map permits. */
type ElicitContentValue = string | number | boolean | string[];

/** A form-mode elicitation request carries a `requestedSchema`. */
function hasRequestedSchema(params: ElicitRequest['params']): params is ElicitRequest['params'] & {
  requestedSchema: unknown;
} {
  return 'requestedSchema' in params;
}

/** Narrow handler-returned content to the primitive record the spec allows. */
function toElicitContent(content: Record<string, unknown>): Record<string, ElicitContentValue> {
  const out: Record<string, ElicitContentValue> = {};
  for (const [key, value] of Object.entries(content)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.every((v): v is string => typeof v === 'string'))
    ) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Build the `elicitation/create` request handler registered on the MCP client.
 * Delegates to the caller's {@link ElicitationHandler}; when none is supplied,
 * auto-declines so a tool call awaiting input fails gracefully instead of
 * hanging. The MCP spec forbids eliciting sensitive/PII data — that contract is
 * the server's responsibility; callers should treat requested fields as such.
 */
export function makeElicitationRequestHandler(
  handler: ElicitationHandler | undefined,
): (request: ElicitRequest) => Promise<ElicitResult> {
  return async (request: ElicitRequest): Promise<ElicitResult> => {
    if (handler === undefined) {
      return {
        action: 'decline',
      };
    }

    const { params } = request;
    const requestedSchema = hasRequestedSchema(params) ? params.requestedSchema : undefined;
    const schema = isJsonSchemaObject(requestedSchema) ? requestedSchema : {};

    const response = await handler({
      message: params.message,
      requestedSchema: schema,
    });

    if (response.action === 'accept') {
      return {
        action: 'accept',
        content: toElicitContent(response.content),
      };
    }
    return {
      action: response.action,
    };
  };
}
