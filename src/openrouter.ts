import { OpenRouterCore } from '@openrouter/sdk/core';
import type { SDKHooks } from '@openrouter/sdk/hooks/hooks';
import type { SDKOptions } from '@openrouter/sdk/lib/config';
import type { RequestOptions } from '@openrouter/sdk/lib/sdks';
import type { $ZodObject, $ZodShape, infer as zodInfer } from 'zod/v4/core';

import { callModel } from './inner-loop/call-model.js';
import type { CallModelInput } from './lib/async-params.js';
import type { ModelResult } from './lib/model-result.js';
import type { Tool } from './lib/tool-types.js';

export type { SDKOptions } from '@openrouter/sdk/lib/config';

/**
 * SDK options extended with optional hooks for request/response interception.
 * The underlying `ClientSDK` accepts hooks at runtime but its constructor type
 * (`SDKOptions`) does not include them. This type bridges that gap.
 */
export type OpenRouterOptions = SDKOptions & { hooks?: SDKHooks };

export class OpenRouter extends OpenRouterCore {
  constructor(options?: OpenRouterOptions) {
    super(options);
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
    return callModel(this, request, options);
  };
}
