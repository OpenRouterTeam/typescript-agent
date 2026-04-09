import { OpenRouterCore } from '@openrouter/sdk/core';
import { describe, expect, it } from 'vitest';
import { ModelResult } from '../../src/lib/model-result.js';
import { OpenRouter } from '../../src/openrouter.js';

describe('OpenRouter', () => {
  it('should instantiate without options', () => {
    const openrouter = new OpenRouter();
    expect(openrouter).toBeInstanceOf(OpenRouter);
  });

  it('should instantiate with apiKey option', () => {
    const openrouter = new OpenRouter({
      apiKey: 'test-key',
    });
    expect(openrouter).toBeInstanceOf(OpenRouter);
  });

  it('should return a ModelResult from callModel', () => {
    const openrouter = new OpenRouter({
      apiKey: 'test-key',
    });
    const result = openrouter.callModel({
      model: 'openai/gpt-4o',
      input: 'Hello',
    });
    expect(result).toBeInstanceOf(ModelResult);
  });

  it('should preserve this binding when callModel is destructured', () => {
    const openrouter = new OpenRouter({
      apiKey: 'test-key',
    });
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

  it('should be an instance of OpenRouterCore', () => {
    const openrouter = new OpenRouter({
      apiKey: 'test-key',
    });
    expect(openrouter).toBeInstanceOf(OpenRouterCore);
  });

  it('should pass constructor options through to the instance', () => {
    const openrouter = new OpenRouter({
      apiKey: 'test-key',
      serverURL: 'https://custom.endpoint.com',
    });
    expect(openrouter).toBeInstanceOf(OpenRouterCore);
    // Verify the instance was constructed with the provided options
    expect(openrouter._options.serverURL).toBe('https://custom.endpoint.com');
  });

  it('should be usable as both OpenRouter and OpenRouterCore', () => {
    const openrouter = new OpenRouter({
      apiKey: 'test-key',
    });
    expect(openrouter).toBeInstanceOf(OpenRouter);
    expect(openrouter).toBeInstanceOf(OpenRouterCore);
    // Calling callModel should still work
    const result = openrouter.callModel({
      model: 'openai/gpt-4o',
      input: 'Hello',
    });
    expect(result).toBeInstanceOf(ModelResult);
  });
});
