import type { ClientTool, Tool } from '@openrouter/agent';
import { isServerTool } from '@openrouter/agent';
import type { ActivationInput, ActivationPredicate } from './types.js';

type Entry<TShared extends Record<string, unknown>> =
  | {
      kind: 'static';
      active: boolean;
    }
  | {
      kind: 'activateWhen';
      predicate: ActivationPredicate<TShared>;
    }
  | {
      kind: 'deactivateWhen';
      predicate: ActivationPredicate<TShared>;
    };

function toNameArray(names: string | readonly string[]): readonly string[] {
  return typeof names === 'string'
    ? [
        names,
      ]
    : names;
}

function isPredicateMap<TShared extends Record<string, unknown>>(
  value: unknown,
): value is Record<string, ActivationPredicate<TShared>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function indexClientTools(tools: readonly Tool[]): Map<string, ClientTool> {
  const map = new Map<string, ClientTool>();
  for (const t of tools) {
    if (isServerTool(t)) {
      continue;
    }
    const name = t.function.name;
    if (map.has(name)) {
      throw new Error(`Duplicate tool name: "${name}"`);
    }
    map.set(name, t);
  }
  return map;
}

export class ToolSet<
  TTools extends readonly Tool[] = readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, unknown>,
> {
  /** All tools in construction order — both client and server. */
  readonly #orderedTools: readonly Tool[];
  /** Name → client tool lookup for activation tracking. Server tools are excluded because they have no `function.name`. */
  readonly #clientToolsByName: Map<string, ClientTool>;
  readonly #activation: Map<string, Entry<TShared>>;
  readonly #mutable: boolean;

  private constructor(
    orderedTools: readonly Tool[],
    clientToolsByName: Map<string, ClientTool>,
    activation: Map<string, Entry<TShared>>,
    mutable: boolean,
  ) {
    this.#orderedTools = orderedTools;
    this.#clientToolsByName = clientToolsByName;
    this.#activation = activation;
    this.#mutable = mutable;
  }

  /** Internal factory. Prefer `createToolSet` for the public API. */
  static create<
    T extends readonly Tool[],
    S extends Record<string, unknown> = Record<string, unknown>,
  >(opts: { tools: T; mutable?: boolean }): ToolSet<T, S> {
    return new ToolSet<T, S>(
      opts.tools,
      indexClientTools(opts.tools),
      new Map(),
      opts.mutable ?? false,
    );
  }

  /** All tools in construction order, regardless of activation state. */
  get tools(): readonly Tool[] {
    return this.#orderedTools;
  }

  #assertKnown(name: string): void {
    if (!this.#clientToolsByName.has(name)) {
      throw new Error(`Unknown tool: "${name}"`);
    }
  }

  #withMutation(
    mutate: (activation: Map<string, Entry<TShared>>) => void,
  ): ToolSet<TTools, TShared> {
    if (this.#mutable) {
      mutate(this.#activation);
      return this;
    }
    const nextActivation = new Map(this.#activation);
    mutate(nextActivation);
    return new ToolSet<TTools, TShared>(
      this.#orderedTools,
      this.#clientToolsByName,
      nextActivation,
      false,
    );
  }

  activate(names: string | readonly string[]): ToolSet<TTools, TShared> {
    const list = toNameArray(names);
    for (const n of list) {
      this.#assertKnown(n);
    }
    return this.#withMutation((activation) => {
      for (const n of list) {
        activation.set(n, {
          kind: 'static',
          active: true,
        });
      }
    });
  }

  deactivate(names: string | readonly string[]): ToolSet<TTools, TShared> {
    const list = toNameArray(names);
    for (const n of list) {
      this.#assertKnown(n);
    }
    return this.#withMutation((activation) => {
      for (const n of list) {
        activation.set(n, {
          kind: 'static',
          active: false,
        });
      }
    });
  }

  activateWhen(name: string, predicate: ActivationPredicate<TShared>): ToolSet<TTools, TShared>;
  activateWhen(map: Record<string, ActivationPredicate<TShared>>): ToolSet<TTools, TShared>;
  activateWhen(
    nameOrMap: string | Record<string, ActivationPredicate<TShared>>,
    predicate?: ActivationPredicate<TShared>,
  ): ToolSet<TTools, TShared> {
    const entries = this.#normalizePredicateArg(nameOrMap, predicate);
    return this.#withMutation((activation) => {
      for (const [n, p] of entries) {
        activation.set(n, {
          kind: 'activateWhen',
          predicate: p,
        });
      }
    });
  }

  deactivateWhen(name: string, predicate: ActivationPredicate<TShared>): ToolSet<TTools, TShared>;
  deactivateWhen(map: Record<string, ActivationPredicate<TShared>>): ToolSet<TTools, TShared>;
  deactivateWhen(
    nameOrMap: string | Record<string, ActivationPredicate<TShared>>,
    predicate?: ActivationPredicate<TShared>,
  ): ToolSet<TTools, TShared> {
    const entries = this.#normalizePredicateArg(nameOrMap, predicate);
    return this.#withMutation((activation) => {
      for (const [n, p] of entries) {
        activation.set(n, {
          kind: 'deactivateWhen',
          predicate: p,
        });
      }
    });
  }

  #normalizePredicateArg(
    nameOrMap: string | Record<string, ActivationPredicate<TShared>>,
    predicate?: ActivationPredicate<TShared>,
  ): Array<
    [
      string,
      ActivationPredicate<TShared>,
    ]
  > {
    if (typeof nameOrMap === 'string') {
      if (!predicate) {
        throw new Error('activateWhen/deactivateWhen requires a predicate when called with a name');
      }
      this.#assertKnown(nameOrMap);
      return [
        [
          nameOrMap,
          predicate,
        ],
      ];
    }
    if (!isPredicateMap<TShared>(nameOrMap)) {
      throw new Error('activateWhen/deactivateWhen requires a name+predicate or predicate map');
    }
    const entries: Array<
      [
        string,
        ActivationPredicate<TShared>,
      ]
    > = Object.entries(nameOrMap);
    for (const [n] of entries) {
      this.#assertKnown(n);
    }
    return entries;
  }

  /**
   * Resolve activation against an input and return the filtered active tools
   * plus the parallel list of active client-tool names, both in construction
   * order. Server tools have no name to filter by and are always included in
   * `tools` (but never appear in `activeTools`).
   */
  inferTools(input?: ActivationInput<TShared>): {
    tools: Tool[];
    activeTools: string[];
  } {
    const resolved: ActivationInput<TShared> = input ?? {};
    const tools: Tool[] = [];
    const activeTools: string[] = [];
    for (const t of this.#orderedTools) {
      if (isServerTool(t)) {
        tools.push(t);
        continue;
      }
      const name = t.function.name;
      if (this.#resolveActive(name, resolved)) {
        tools.push(t);
        activeTools.push(name);
      }
    }
    return {
      tools,
      activeTools,
    };
  }

  #resolveActive(name: string, input: ActivationInput<TShared>): boolean {
    const entry = this.#activation.get(name);
    if (!entry) {
      return true;
    }
    if (entry.kind === 'static') {
      return entry.active;
    }
    if (entry.kind === 'activateWhen') {
      return entry.predicate(input) === true;
    }
    return entry.predicate(input) !== true;
  }

  clone(opts?: { mutable?: boolean }): ToolSet<TTools, TShared> {
    return new ToolSet<TTools, TShared>(
      this.#orderedTools,
      this.#clientToolsByName,
      new Map(this.#activation),
      opts?.mutable ?? this.#mutable,
    );
  }
}

export function createToolSet<
  T extends readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, unknown>,
>(opts: { tools: T; mutable?: boolean }): ToolSet<T, TShared> {
  return ToolSet.create<T, TShared>({
    tools: opts.tools,
    ...(opts.mutable !== undefined && {
      mutable: opts.mutable,
    }),
  });
}
