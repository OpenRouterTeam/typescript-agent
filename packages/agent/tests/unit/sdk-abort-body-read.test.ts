/**
 * Regression test for OpenRouterTeam/typescript-sdk#350.
 *
 * Before @openrouter/sdk 0.13.59, aborting a request while the SDK was still
 * reading a non-streamed (JSON) response body left an internal APIPromise
 * rejected with no handler, so each aborted call surfaced a process-level
 * `unhandledRejection` even though the caller's own promise rejected and was
 * handled. The agent can't intercept that from the outside, so this test pins
 * the SDK floor: it runs the real SDK (no mocks) against a local server that
 * sends JSON headers plus a partial body and then stalls.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenRouterCore } from '@openrouter/sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callModel } from '../../src/inner-loop/call-model.js';

let server: http.Server;
let requestsReceived = 0;
let unhandledRejections: unknown[] = [];
const onUnhandled = (err: unknown) => {
  unhandledRejections.push(err);
};

beforeEach(async () => {
  requestsReceived = 0;
  unhandledRejections = [];
  process.on('unhandledRejection', onUnhandled);
  server = http.createServer((req, res) => {
    req.resume();
    requestsReceived++;
    // JSON (non-event-stream) response whose body never completes.
    res.writeHead(200, {
      'content-type': 'application/json',
    });
    res.write('{"id":');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  process.off('unhandledRejection', onUnhandled);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('aborting during a non-streamed body read (typescript-sdk#350)', () => {
  it('rejects every parallel call without leaking unhandled rejections', async () => {
    const { port } = server.address() as AddressInfo;
    const client = new OpenRouterCore({
      apiKey: 'test-key',
      serverURL: `http://127.0.0.1:${port}/api/v1`,
    });
    const controller = new AbortController();

    const calls = [
      1,
      2,
      3,
    ].map(() =>
      callModel(client, {
        model: 'test-model',
        input: 'hello',
        signal: controller.signal,
      }).getResponse(),
    );

    // Abort only once every request is mid-body, i.e. on the SDK's JSON read path.
    await vi.waitFor(() => expect(requestsReceived).toBe(3));
    controller.abort();

    const settled = await Promise.allSettled(calls);
    // Give any dangling rejection a chance to reach the process handler.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(settled.map((s) => s.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(unhandledRejections).toHaveLength(0);
  });
});
