import { OpenRouter, stepCountIs, tool } from '../../packages/agent/esm/index.js';
import { betaResponsesSend } from '../../packages/agent/node_modules/@openrouter/sdk/esm/funcs/betaResponsesSend.js';
import { z } from '../../packages/agent/node_modules/zod/v4/index.js';

export { betaResponsesSend, OpenRouter, stepCountIs, tool, z };

export async function runAgent(apiKey, input = 'Reply with exactly the word ok.') {
  const client = new OpenRouter({
    apiKey,
  });
  const response = await client
    .callModel({
      model: 'openai/gpt-4.1-nano',
      input,
      maxOutputTokens: 16,
      temperature: 0,
    })
    .getResponse();

  return {
    status: response.status,
    outputTokens: response.usage?.outputTokens ?? 0,
  };
}

export default {
  async fetch(request, env) {
    const input = new URL(request.url).searchParams.get('input') ?? undefined;
    return Response.json(await runAgent(env.OPENROUTER_TEST_KEY, input));
  },
};
