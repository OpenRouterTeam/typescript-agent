import { OpenRouterCore } from '@openrouter/sdk/core';
import { SDKHooks } from '@openrouter/sdk/hooks/hooks';
import type {
  AfterSuccessHook,
  BeforeRequestContext,
  BeforeRequestHook,
} from '@openrouter/sdk/hooks/types';
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

  describe('hooks', () => {
    const noopBeforeRequest: BeforeRequestHook = {
      beforeRequest: async (_ctx: BeforeRequestContext, request: Request) => request,
    };
    const noopAfterSuccess: AfterSuccessHook = {
      afterSuccess: async (_ctx, response) => response,
    };

    it('should expose an SDKHooks instance on _options by default', () => {
      const openrouter = new OpenRouter({
        apiKey: 'test-key',
      });
      expect(openrouter._options.hooks).toBeInstanceOf(SDKHooks);
    });

    it('should use a passed SDKHooks instance as-is', () => {
      const hooks = new SDKHooks();
      hooks.registerBeforeRequestHook(noopBeforeRequest);
      const openrouter = new OpenRouter({
        apiKey: 'test-key',
        hooks,
      });
      expect(openrouter._options.hooks).toBe(hooks);
      expect(openrouter._options.hooks?.beforeRequestHooks).toHaveLength(1);
    });

    it('should wrap a single hook object into an SDKHooks instance', () => {
      const openrouter = new OpenRouter({
        apiKey: 'test-key',
        hooks: noopBeforeRequest,
      });
      expect(openrouter._options.hooks).toBeInstanceOf(SDKHooks);
      expect(openrouter._options.hooks?.beforeRequestHooks).toHaveLength(1);
      expect(openrouter._options.hooks?.beforeRequestHooks[0]).toBe(noopBeforeRequest);
    });

    it('should wrap an array of hook objects into an SDKHooks instance', () => {
      const openrouter = new OpenRouter({
        apiKey: 'test-key',
        hooks: [
          noopBeforeRequest,
          noopAfterSuccess,
        ],
      });
      expect(openrouter._options.hooks).toBeInstanceOf(SDKHooks);
      expect(openrouter._options.hooks?.beforeRequestHooks).toHaveLength(1);
      expect(openrouter._options.hooks?.afterSuccessHooks).toHaveLength(1);
    });

    it('should register a hook object that implements multiple hook interfaces under every matching slot', () => {
      const combined: BeforeRequestHook & AfterSuccessHook = {
        beforeRequest: async (_ctx, request) => request,
        afterSuccess: async (_ctx, response) => response,
      };
      const openrouter = new OpenRouter({
        apiKey: 'test-key',
        hooks: combined,
      });
      expect(openrouter._options.hooks?.beforeRequestHooks).toHaveLength(1);
      expect(openrouter._options.hooks?.afterSuccessHooks).toHaveLength(1);
    });
  });
});
