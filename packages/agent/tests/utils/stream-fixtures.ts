/**
 * Shared Responses stream fixtures for the stream watchdog / typed stream
 * error tests (DEV-723). Events are in the parsed (camelCase) shape that
 * `betaResponsesSend` yields, so tests can mock it with a ReadableStream.
 */
import type * as models from '@openrouter/sdk/models';

let counter = 0;

export function baseResponse(
  output: unknown[],
  overrides: Partial<models.OpenResponsesResult> = {},
): models.OpenResponsesResult {
  counter++;
  return {
    id: `resp_${counter}`,
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output,
    error: null,
    incompleteDetails: null,
    temperature: null,
    topP: null,
    presencePenalty: null,
    frequencyPenalty: null,
    metadata: null,
    instructions: null,
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
    ...overrides,
  } as models.OpenResponsesResult;
}

export function textResponse(text: string): models.OpenResponsesResult {
  return baseResponse([
    {
      id: `msg_${counter}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text,
          annotations: [],
        },
      ],
    },
  ]);
}

export function toolCallResponse(name: string, args: unknown): models.OpenResponsesResult {
  return baseResponse([
    {
      type: 'function_call',
      id: `fc_${counter}`,
      callId: `call_${counter}`,
      name,
      arguments: JSON.stringify(args),
      status: 'completed',
    },
  ]);
}

export function createdEvent(): models.StreamEvents {
  return {
    type: 'response.created',
    response: baseResponse([], {
      status: 'in_progress',
    }),
    sequenceNumber: 0,
  } as models.StreamEvents;
}

/** An empty assistant-message shell: the role prelude that must NOT count as content. */
export function emptyMessageShell(): models.StreamEvents {
  return {
    type: 'response.output_item.added',
    outputIndex: 0,
    item: {
      type: 'message',
      id: 'msg_shell',
      role: 'assistant',
      status: 'in_progress',
      content: [],
    },
    sequenceNumber: 0,
  } as models.StreamEvents;
}

export function textDelta(delta: string): models.StreamEvents {
  return {
    type: 'response.output_text.delta',
    delta,
    itemId: 'msg_shell',
    contentIndex: 0,
    outputIndex: 0,
    logprobs: [],
    sequenceNumber: 1,
  } as models.StreamEvents;
}

export function reasoningDelta(delta: string): models.StreamEvents {
  return {
    type: 'response.reasoning_text.delta',
    delta,
    itemId: 'rs_1',
    contentIndex: 0,
    outputIndex: 0,
    sequenceNumber: 1,
  } as models.StreamEvents;
}

export function functionCallArgsDelta(delta: string): models.StreamEvents {
  return {
    type: 'response.function_call_arguments.delta',
    delta,
    itemId: 'fc_1',
    outputIndex: 0,
    sequenceNumber: 1,
  } as models.StreamEvents;
}

export function completedEvent(response: models.OpenResponsesResult): models.StreamEvents {
  return {
    type: 'response.completed',
    response,
    sequenceNumber: 9,
  } as models.StreamEvents;
}

export function failedEvent(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): models.StreamEvents {
  return {
    type: 'response.failed',
    response: baseResponse([], {
      status: 'failed',
      error: {
        code,
        message,
      } as models.OpenResponsesResult['error'],
      ...extra,
    }),
    sequenceNumber: 9,
  } as models.StreamEvents;
}

export function errorEvent(code: string | null, message: string): models.StreamEvents {
  return {
    type: 'error',
    code,
    message,
    param: null,
    sequenceNumber: 5,
  } as models.StreamEvents;
}

/** A healthy single-turn stream: created, shell, delta, completed, close. */
export function healthyTextEvents(text: string): models.StreamEvents[] {
  return [
    createdEvent(),
    emptyMessageShell(),
    textDelta(text),
    completedEvent(textResponse(text)),
  ];
}

export function healthyToolCallEvents(name: string, args: unknown): models.StreamEvents[] {
  return [
    createdEvent(),
    functionCallArgsDelta(JSON.stringify(args)),
    completedEvent(toolCallResponse(name, args)),
  ];
}

/**
 * A ReadableStream driven by the test. Never closes on its own: a test that
 * stops pushing simulates a hung connection.
 */
export interface ControlledStream<T> {
  stream: ReadableStream<T>;
  push: (...events: T[]) => void;
  close: () => void;
  error: (reason: unknown) => void;
  readonly cancelled: boolean;
  readonly cancelReason: unknown;
  /** Closed, errored or cancelled: the source is torn down either way. */
  readonly finished: boolean;
}

export function controlledStream<T = models.StreamEvents>(initial: T[] = []): ControlledStream<T> {
  let controller!: ReadableStreamDefaultController<T>;
  let cancelled = false;
  let cancelReason: unknown;
  let done = false;
  const stream = new ReadableStream<T>({
    start(c) {
      controller = c;
      for (const event of initial) {
        c.enqueue(event);
      }
    },
    cancel(reason) {
      cancelled = true;
      cancelReason = reason;
      done = true;
    },
  });
  return {
    stream,
    push: (...events) => {
      if (done) {
        return;
      }
      for (const event of events) {
        controller.enqueue(event);
      }
    },
    close: () => {
      if (!done) {
        done = true;
        controller.close();
      }
    },
    error: (reason) => {
      if (!done) {
        done = true;
        controller.error(reason);
      }
    },
    get cancelled() {
      return cancelled;
    },
    get cancelReason() {
      return cancelReason;
    },
    get finished() {
      return done;
    },
  };
}

/** A stream that replays `events` then closes. */
export function closedStream<T = models.StreamEvents>(events: T[]): ReadableStream<T> {
  const controlled = controlledStream<T>(events);
  controlled.close();
  return controlled.stream;
}

/** Drain an async iterable, returning what it yielded and how it ended. */
export async function drain<T>(iterable: AsyncIterable<T>): Promise<{
  items: T[];
  error: unknown;
  threw: boolean;
}> {
  const items: T[] = [];
  try {
    for await (const item of iterable) {
      items.push(item);
    }
    return {
      items,
      error: undefined,
      threw: false,
    };
  } catch (error) {
    return {
      items,
      error,
      threw: true,
    };
  }
}
