import { describe, expect, it } from 'vitest';
import { OpenRouter } from '../../src/openrouter.js';
import { ModelResult } from '../../src/lib/model-result.js';

describe('OpenRouter', () => {
  it('should instantiate without options', () => {
    const openrouter = new OpenRouter();
    expect(openrouter).toBeInstanceOf(OpenRouter);
  });

  it('should instantiate with apiKey option', () => {
    const openrouter = new OpenRouter({ apiKey: 'test-key' });
    expect(openrouter).toBeInstanceOf(OpenRouter);
  });

  it('should return a ModelResult from callModel', () => {
    const openrouter = new OpenRouter({ apiKey: 'test-key' });
    const result = openrouter.callModel({
      model: 'openai/gpt-4o',
      input: 'Hello',
    });
    expect(result).toBeInstanceOf(ModelResult);
  });

  it('should preserve this binding when callModel is destructured', () => {
    const openrouter = new OpenRouter({ apiKey: 'test-key' });
    const { callModel } = openrouter;
    const result = callModel({
      model: 'openai/gpt-4o',
      input: 'Hello',
    });
    expect(result).toBeInstanceOf(ModelResult);
  });

  it('should accept SDK options like serverURL', () => {
    const openrouter = new OpenRouter({
      apiKey: 'test-key',
      serverURL: 'https://custom.endpoint.com',
    });
    expect(openrouter).toBeInstanceOf(OpenRouter);
  });
});
