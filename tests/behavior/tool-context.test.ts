import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  buildToolExecuteContext,
  extractToolContext,
  resolveContext,
  ToolContextStore,
} from '../../src/lib/tool-context.js';
import type { TurnContext } from '../../src/lib/tool-types.js';

const turnCtx: TurnContext = {
  numberOfTurns: 1,
};

describe('ToolContextStore - basic operations', () => {
  it('constructor initializes with given values', () => {
    const store = new ToolContextStore({
      weather: {
        apiKey: '123',
      },
    });
    expect(store.getToolContext('weather')).toEqual({
      apiKey: '123',
    });
  });

  it('getToolContext returns empty object for unknown tool', () => {
    const store = new ToolContextStore();
    expect(store.getToolContext('unknown')).toEqual({});
  });

  it('setToolContext sets tool context and notifies listeners', () => {
    const store = new ToolContextStore();
    const snapshots: Array<Record<string, unknown>> = [];
    store.subscribe((s) => snapshots.push(s));
    store.setToolContext('tool1', {
      key: 'val',
    });
    expect(store.getToolContext('tool1')).toEqual({
      key: 'val',
    });
    expect(snapshots).toHaveLength(1);
  });

  it('mergeToolContext merges partial values', () => {
    const store = new ToolContextStore({
      tool1: {
        a: 1,
        b: 2,
      },
    });
    store.mergeToolContext('tool1', {
      b: 99,
      c: 3,
    });
    expect(store.getToolContext('tool1')).toEqual({
      a: 1,
      b: 99,
      c: 3,
    });
  });

  it('getSnapshot returns deep-shallow copy of all contexts', () => {
    const store = new ToolContextStore({
      a: {
        x: 1,
      },
      b: {
        y: 2,
      },
    });
    const snapshot = store.getSnapshot();
    expect(snapshot).toEqual({
      a: {
        x: 1,
      },
      b: {
        y: 2,
      },
    });
    snapshot.a!.x = 999;
    expect(store.getToolContext('a')).toEqual({
      x: 1,
    });
  });

  it('subscribe returns unsubscribe function', () => {
    const store = new ToolContextStore();
    const calls: number[] = [];
    const unsub = store.subscribe(() => calls.push(1));
    store.setToolContext('t', {
      v: 1,
    });
    expect(calls).toHaveLength(1);
    unsub();
    store.setToolContext('t', {
      v: 2,
    });
    expect(calls).toHaveLength(1);
  });
});

describe('buildToolExecuteContext', () => {
  it('returns object with turnContext fields merged', () => {
    const ctx = buildToolExecuteContext(turnCtx, undefined, 'myTool', undefined);
    expect(ctx.numberOfTurns).toBe(1);
  });

  it('local getter reads from store for the tool name', () => {
    const store = new ToolContextStore({
      myTool: {
        apiKey: 'abc',
      },
    });
    const schema = z.object({
      apiKey: z.string(),
    });
    const ctx = buildToolExecuteContext(turnCtx, store, 'myTool', schema);
    expect(ctx.local).toEqual({
      apiKey: 'abc',
    });
  });

  it('setContext merges partial values into store', () => {
    const store = new ToolContextStore({
      myTool: {
        apiKey: 'abc',
      },
    });
    const schema = z.object({
      apiKey: z.string(),
    });
    const ctx = buildToolExecuteContext(turnCtx, store, 'myTool', schema);
    ctx.setContext({
      apiKey: 'xyz',
    });
    expect(ctx.local).toEqual({
      apiKey: 'xyz',
    });
  });

  it('shared getter reads shared context from store', () => {
    const store = new ToolContextStore({
      shared: {
        globalKey: 'val',
      },
    });
    const sharedSchema = z.object({
      globalKey: z.string(),
    });
    const ctx = buildToolExecuteContext(turnCtx, store, 'myTool', undefined, sharedSchema);
    expect(ctx.shared).toEqual({
      globalKey: 'val',
    });
  });

  it('setSharedContext updates shared context in store', () => {
    const store = new ToolContextStore({
      shared: {
        globalKey: 'old',
      },
    });
    const sharedSchema = z.object({
      globalKey: z.string(),
    });
    const ctx = buildToolExecuteContext(turnCtx, store, 'myTool', undefined, sharedSchema);
    ctx.setSharedContext({
      globalKey: 'new',
    });
    expect(ctx.shared).toEqual({
      globalKey: 'new',
    });
  });

  it('local getter returns frozen object', () => {
    const store = new ToolContextStore({
      myTool: {
        val: 1,
      },
    });
    const schema = z.object({
      val: z.number(),
    });
    const ctx = buildToolExecuteContext(turnCtx, store, 'myTool', schema);
    expect(Object.isFrozen(ctx.local)).toBe(true);
  });
});

describe('resolveContext', () => {
  it('returns empty object when input is undefined', async () => {
    const result = await resolveContext(undefined, turnCtx);
    expect(result).toEqual({});
  });

  it('returns static value as-is', async () => {
    const input = {
      myTool: {
        apiKey: '123',
      },
    };
    const result = await resolveContext(input, turnCtx);
    expect(result).toEqual({
      myTool: {
        apiKey: '123',
      },
    });
  });

  it('calls sync function with turnContext and returns result', async () => {
    const fn = (ctx: TurnContext) => ({
      tool: {
        turn: ctx.numberOfTurns,
      },
    });
    const result = await resolveContext(fn, turnCtx);
    expect(result).toEqual({
      tool: {
        turn: 1,
      },
    });
  });

  it('calls async function with turnContext and returns result', async () => {
    const fn = async (ctx: TurnContext) => ({
      tool: {
        turn: ctx.numberOfTurns * 2,
      },
    });
    const result = await resolveContext(fn, turnCtx);
    expect(result).toEqual({
      tool: {
        turn: 2,
      },
    });
  });
});

describe('extractToolContext', () => {
  it('extracts and validates context for tool', () => {
    const store = new ToolContextStore({
      myTool: {
        apiKey: 'abc',
      },
    });
    const schema = z.object({
      apiKey: z.string(),
    });
    const result = extractToolContext(store, 'myTool', schema);
    expect(result).toEqual({
      apiKey: 'abc',
    });
  });

  it('returns empty object when no schema provided', () => {
    const store = new ToolContextStore({
      myTool: {
        apiKey: 'abc',
      },
    });
    const result = extractToolContext(store, 'myTool', undefined);
    expect(result).toEqual({});
  });
});
