import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { makeElicitationRequestHandler } from '../../src/elicitation.js';

function formRequest(): ElicitRequest {
  return {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: 'Need your name',
      requestedSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
          },
        },
      },
    },
  };
}

describe('makeElicitationRequestHandler', () => {
  it('auto-declines when no handler is provided', async () => {
    const handle = makeElicitationRequestHandler(undefined);
    expect(await handle(formRequest())).toEqual({
      action: 'decline',
    });
  });

  it('passes message + schema to the handler and returns accepted content', async () => {
    const handle = makeElicitationRequestHandler((req) => {
      expect(req.message).toBe('Need your name');
      expect(req.requestedSchema['type']).toBe('object');
      return {
        action: 'accept',
        content: {
          name: 'Ada',
        },
      };
    });
    expect(await handle(formRequest())).toEqual({
      action: 'accept',
      content: {
        name: 'Ada',
      },
    });
  });

  it('drops non-primitive values from accepted content', async () => {
    const handle = makeElicitationRequestHandler(() => ({
      action: 'accept',
      content: {
        ok: 'yes',
        nested: {
          bad: true,
        },
        count: 2,
      },
    }));
    expect(await handle(formRequest())).toEqual({
      action: 'accept',
      content: {
        ok: 'yes',
        count: 2,
      },
    });
  });

  it('forwards decline and cancel actions', async () => {
    const decline = makeElicitationRequestHandler(() => ({
      action: 'decline',
    }));
    const cancel = makeElicitationRequestHandler(() => ({
      action: 'cancel',
    }));
    expect(await decline(formRequest())).toEqual({
      action: 'decline',
    });
    expect(await cancel(formRequest())).toEqual({
      action: 'cancel',
    });
  });
});
