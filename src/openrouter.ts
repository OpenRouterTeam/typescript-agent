import { OpenRouterCore } from '@openrouter/sdk/core';
import type { SDKOptions } from '@openrouter/sdk/lib/config';
import type { RequestOptions } from '@openrouter/sdk/lib/sdks';
import type { $ZodObject, $ZodShape, infer as zodInfer } from 'zod/v4/core';

import { callModel } from './inner-loop/call-model.js';
import type { CallModelInput } from './lib/async-params.js';
import type { ModelResult } from './lib/model-result.js';
import type { Tool } from './lib/tool-types.js';

export type { SDKOptions } from '@openrouter/sdk/lib/config';

export class OpenRouter {
  private client: OpenRouterCore;

  constructor(options?: SDKOptions) {
    this.client = new OpenRouterCore(options);
  }

  callModel = <
    TTools extends readonly Tool[],
    TSharedSchema extends $ZodObject<$ZodShape> | undefined = undefined,
    TShared extends Record<string, unknown> = TSharedSchema extends $ZodObject<$ZodShape>
      ? zodInfer<TSharedSchema>
      : Record<string, never>,
  >(
    request: CallModelInput<TTools, TShared> & {
      sharedContextSchema?: TSharedSchema;
    },
    options?: RequestOptions,
  ): ModelResult<TTools, TShared> => {
    return callModel(this.client, request, options);
  };
}
