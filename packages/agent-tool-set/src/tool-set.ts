import type { ServerToolBase, Tool } from '@openrouter/agent';
import { isServerTool } from '@openrouter/agent';
import type {
  ActivatePartition,
  ActivationInput,
  ActivationPredicate,
  ApplySituationPartition,
  ClientToolNamesOfTuple,
  ConditionalPartition,
  DeactivatePartition,
  EmptySituations,
  FilterToolsByIds,
  InferSituationMap,
  InitialPartition,
  Partition,
  ResolvedToolSnapshot,
  ServerToolIdsOfTuple,
  SituationConditionalRule,
  SituationConfig,
  SituationMap,
  SituationNames,
  StatusByToolMap,
  StatusReason,
  ToolIdOf,
  ToolIdsOfTuple,
  ToolStatusEntry,
} from './types.js';

type ActivationEntry<TShared extends Record<string, unknown>> =
  | {
      kind: 'static';
      active: boolean;
      source: 'default' | 'activate' | 'deactivate' | 'situation';
    }
  | {
      kind: 'activateWhen';
      predicate: ActivationPredicate<TShared>;
      source: 'activateWhen' | 'situation';
    }
  | {
      kind: 'deactivateWhen';
      predicate: ActivationPredicate<TShared>;
      source: 'deactivateWhen' | 'situation';
    };

type SituationRuntime<TShared extends Record<string, unknown>> = {
  enabled: readonly string[];
  disabled: readonly string[];
  conditional: ReadonlyArray<{
    id: string;
    mode: 'activateWhen' | 'deactivateWhen';
    predicate: ActivationPredicate<TShared>;
  }>;
};

type IndexedTools<TTools extends readonly Tool[]> = {
  orderedTools: TTools;
  /** Every known ID in construction order. */
  orderedIds: readonly ToolIdsOfTuple<TTools>[];
  toolById: Map<string, Tool>;
  clientNames: Set<string>;
  serverIds: Set<string>;
};

function toIdArray(names: string | readonly string[]): readonly string[] {
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

function defaultServerId(tool: ServerToolBase): string {
  return typeof tool.id === 'string' && tool.id.length > 0 ? tool.id : `server:${tool.config.type}`;
}

function toolId(tool: Tool): string {
  if (isServerTool(tool)) {
    return defaultServerId(tool);
  }
  // After the ServerToolBase narrow, remaining tools are client tools with function.name.
  return (tool as Exclude<Tool, ServerToolBase>).function.name;
}

function indexTools<TTools extends readonly Tool[]>(tools: TTools): IndexedTools<TTools> {
  const toolById = new Map<string, Tool>();
  const orderedIds: string[] = [];
  const clientNames = new Set<string>();
  const serverIds = new Set<string>();

  for (const t of tools) {
    const id = toolId(t);
    if (toolById.has(id)) {
      throw new Error(`Duplicate tool ID: "${id}"`);
    }
    toolById.set(id, t);
    orderedIds.push(id);
    if (isServerTool(t)) {
      serverIds.add(id);
    } else {
      clientNames.add(id);
    }
  }

  return {
    orderedTools: tools,
    orderedIds: orderedIds as unknown as readonly ToolIdsOfTuple<TTools>[],
    toolById,
    clientNames,
    serverIds,
  };
}

function cloneActivationMap<TShared extends Record<string, unknown>>(
  activation: Map<string, ActivationEntry<TShared>>,
): Map<string, ActivationEntry<TShared>> {
  return new Map(activation);
}

function cloneSituationsMap<TShared extends Record<string, unknown>>(
  situations: Map<string, SituationRuntime<TShared>>,
): Map<string, SituationRuntime<TShared>> {
  return new Map(situations);
}

function normalizeConditionalRule<TShared extends Record<string, unknown>>(
  rule: SituationConditionalRule<TShared>,
): {
  mode: 'activateWhen' | 'deactivateWhen';
  predicate: ActivationPredicate<TShared>;
} {
  if (typeof rule === 'function') {
    return {
      mode: 'activateWhen',
      predicate: rule,
    };
  }
  return {
    mode: rule.mode ?? 'activateWhen',
    predicate: rule.predicate,
  };
}

/**
 * Immutable-by-default stateful set of tools with a three-way static
 * partition (enabled / disabled / conditional) and optional named situations.
 *
 * @typeParam TTools - Concrete ordered tools tuple
 * @typeParam TShared - Shared context shape for predicates
 * @typeParam P - Compile-time partition of tool-set IDs
 * @typeParam Sit - Named situation registry
 */
export class ToolSet<
  TTools extends readonly Tool[] = readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, unknown>,
  P extends Partition = InitialPartition<TTools>,
  Sit extends SituationMap = EmptySituations,
> {
  readonly #index: IndexedTools<TTools>;
  readonly #activation: Map<string, ActivationEntry<TShared>>;
  readonly #situations: Map<string, SituationRuntime<TShared>>;
  readonly #mutable: boolean;

  /**
   * Phantom carriers so inference utilities can recover partition/situation
   * generics from a concrete instance type.
   */
  readonly _partition?: P;
  readonly _situations?: Sit;
  readonly _shared?: TShared;

  private constructor(
    index: IndexedTools<TTools>,
    activation: Map<string, ActivationEntry<TShared>>,
    situations: Map<string, SituationRuntime<TShared>>,
    mutable: boolean,
  ) {
    this.#index = index;
    this.#activation = activation;
    this.#situations = situations;
    this.#mutable = mutable;
  }

  /** Internal factory. Prefer `createToolSet` for the public API. */
  static create<
    T extends readonly Tool[],
    S extends Record<string, unknown> = Record<string, unknown>,
  >(opts: { tools: T; mutable?: boolean }): ToolSet<T, S, InitialPartition<T>, EmptySituations> {
    return new ToolSet<T, S, InitialPartition<T>, EmptySituations>(
      indexTools(opts.tools),
      new Map(),
      new Map(),
      opts.mutable ?? false,
    );
  }

  /** All tools in construction order, regardless of activation state. */
  get tools(): TTools {
    return this.#index.orderedTools;
  }

  #assertKnown(id: string): void {
    if (!this.#index.toolById.has(id)) {
      throw new Error(`Unknown tool: "${id}"`);
    }
  }

  #withPartitionMutation<NextP extends Partition>(
    mutate: (activation: Map<string, ActivationEntry<TShared>>) => void,
  ): ToolSet<TTools, TShared, NextP, Sit> {
    if (this.#mutable) {
      // Mutable mode deliberately does not refine partition type params —
      // successive mutations would leave stale compile-time brands. Runtime state still updates.
      mutate(this.#activation);
      return this as unknown as ToolSet<TTools, TShared, NextP, Sit>;
    }
    const nextActivation = cloneActivationMap(this.#activation);
    mutate(nextActivation);
    return new ToolSet<TTools, TShared, NextP, Sit>(
      this.#index,
      nextActivation,
      this.#situations,
      false,
    );
  }

  activate<const N extends ToolIdsOfTuple<TTools>>(
    names: N | readonly N[],
  ): ToolSet<TTools, TShared, ActivatePartition<P, N>, Sit> {
    const list = toIdArray(names as string | readonly string[]);
    for (const n of list) {
      this.#assertKnown(n);
    }
    return this.#withPartitionMutation<ActivatePartition<P, N>>((activation) => {
      for (const n of list) {
        activation.set(n, {
          kind: 'static',
          active: true,
          source: 'activate',
        });
      }
    });
  }

  deactivate<const N extends ToolIdsOfTuple<TTools>>(
    names: N | readonly N[],
  ): ToolSet<TTools, TShared, DeactivatePartition<P, N>, Sit> {
    const list = toIdArray(names as string | readonly string[]);
    for (const n of list) {
      this.#assertKnown(n);
    }
    return this.#withPartitionMutation<DeactivatePartition<P, N>>((activation) => {
      for (const n of list) {
        activation.set(n, {
          kind: 'static',
          active: false,
          source: 'deactivate',
        });
      }
    });
  }

  activateWhen<const N extends ToolIdsOfTuple<TTools>>(
    name: N,
    predicate: ActivationPredicate<TShared>,
  ): ToolSet<TTools, TShared, ConditionalPartition<P, N>, Sit>;
  activateWhen<const N extends ToolIdsOfTuple<TTools>>(
    map: {
      readonly [K in N]?: ActivationPredicate<TShared>;
    },
  ): ToolSet<TTools, TShared, ConditionalPartition<P, N>, Sit>;
  activateWhen(
    nameOrMap: unknown,
    predicate?: ActivationPredicate<TShared>,
  ): ToolSet<TTools, TShared, any, Sit> {
    const entries = this.#normalizePredicateArg(
      nameOrMap as string | Partial<Record<string, ActivationPredicate<TShared>>>,
      predicate,
    );
    return this.#withPartitionMutation<Partition>((activation) => {
      for (const [n, p] of entries) {
        activation.set(n, {
          kind: 'activateWhen',
          predicate: p,
          source: 'activateWhen',
        });
      }
    });
  }

  deactivateWhen<const N extends ToolIdsOfTuple<TTools>>(
    name: N,
    predicate: ActivationPredicate<TShared>,
  ): ToolSet<TTools, TShared, ConditionalPartition<P, N>, Sit>;
  deactivateWhen<const N extends ToolIdsOfTuple<TTools>>(
    map: {
      readonly [K in N]?: ActivationPredicate<TShared>;
    },
  ): ToolSet<TTools, TShared, ConditionalPartition<P, N>, Sit>;
  deactivateWhen(
    nameOrMap: unknown,
    predicate?: ActivationPredicate<TShared>,
  ): ToolSet<TTools, TShared, any, Sit> {
    const entries = this.#normalizePredicateArg(
      nameOrMap as string | Partial<Record<string, ActivationPredicate<TShared>>>,
      predicate,
    );
    return this.#withPartitionMutation<Partition>((activation) => {
      for (const [n, p] of entries) {
        activation.set(n, {
          kind: 'deactivateWhen',
          predicate: p,
          source: 'deactivateWhen',
        });
      }
    });
  }

  #normalizePredicateArg(
    nameOrMap: string | Partial<Record<string, ActivationPredicate<TShared>>>,
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
    > = Object.entries(nameOrMap).filter(
      (
        entry,
      ): entry is [
        string,
        ActivationPredicate<TShared>,
      ] => typeof entry[1] === 'function',
    );
    for (const [n] of entries) {
      this.#assertKnown(n);
    }
    return entries;
  }

  /**
   * Register named declarative situations. Each situation overlays the base
   * partition — ids it does not mention keep whatever the base set declares.
   *
   * Replaces any previously defined situations (last-call-wins at the registry level).
   */
  defineSituations<
    const M extends {
      readonly [K in string]: SituationConfig<ToolIdsOfTuple<TTools>, TShared>;
    },
  >(situations: M): ToolSet<TTools, TShared, P, InferSituationMap<M>> {
    const next = new Map<string, SituationRuntime<TShared>>();

    for (const [name, config] of Object.entries(situations) as Array<
      [
        string,
        SituationConfig<string, TShared>,
      ]
    >) {
      const enabled = config.enabled ?? [];
      const disabled = config.disabled ?? [];
      const conditionalEntries = Object.entries(config.conditional ?? {}) as Array<
        [
          string,
          SituationConditionalRule<TShared>,
        ]
      >;

      const seen = new Set<string>();
      const record = (id: string, bucket: string): void => {
        this.#assertKnown(id);
        if (seen.has(id)) {
          throw new Error(
            `Situation "${name}" lists tool "${id}" more than once (across enabled/disabled/conditional)`,
          );
        }
        seen.add(id);
        void bucket;
      };

      for (const id of enabled) {
        record(id, 'enabled');
      }
      for (const id of disabled) {
        record(id, 'disabled');
      }
      for (const [id] of conditionalEntries) {
        record(id, 'conditional');
      }

      next.set(name, {
        enabled: [
          ...enabled,
        ],
        disabled: [
          ...disabled,
        ],
        conditional: conditionalEntries.map(([id, rule]) => {
          const normalized = normalizeConditionalRule(rule);
          return {
            id,
            mode: normalized.mode,
            predicate: normalized.predicate,
          };
        }),
      });
    }

    if (this.#mutable) {
      this.#situations.clear();
      for (const [k, v] of next) {
        this.#situations.set(k, v);
      }
      return this as unknown as ToolSet<TTools, TShared, P, InferSituationMap<M>>;
    }

    return new ToolSet<TTools, TShared, P, InferSituationMap<M>>(
      this.#index,
      cloneActivationMap(this.#activation),
      next,
      false,
    );
  }

  /**
   * Resolve against the base partition (no situation overlay).
   * When the partition is purely static, the active tool tuple is exact at
   * compile time. Conditional ids expand the compile-time upper bound.
   */
  resolve(input?: ActivationInput<TShared>): ResolvedToolSnapshot<
    TTools,
    P,
    [
      P['conditional'],
    ] extends [
      never,
    ]
      ? P['enabled']
      : P['enabled'] | P['conditional']
  > {
    return this.#resolveWithActivation(this.#activation, input) as unknown as ResolvedToolSnapshot<
      TTools,
      P,
      [
        P['conditional'],
      ] extends [
        never,
      ]
        ? P['enabled']
        : P['enabled'] | P['conditional']
    >;
  }

  /**
   * Back-compat alias for {@link resolve}. Prefer `resolve` for new code.
   */
  inferTools(input?: ActivationInput<TShared>): {
    tools: Tool[];
    activeTools: string[];
    enabled: readonly string[];
    disabled: readonly string[];
    statusByTool: StatusByToolMap<string>;
  } {
    const snapshot = this.resolve(input);
    return {
      tools: [
        ...snapshot.tools,
      ],
      activeTools: [
        ...snapshot.activeTools,
      ],
      enabled: snapshot.enabled,
      disabled: snapshot.disabled,
      statusByTool: snapshot.statusByTool,
    };
  }

  /**
   * Resolve a previously-defined named situation. Static situations return
   * exact filtered tool / name tuples at compile time; situations with
   * conditional rules return the sound upper bound, while runtime arrays and
   * `statusByTool` remain exact.
   */
  resolveSituation<Name extends SituationNames<Sit>>(
    name: Name,
    input?: ActivationInput<TShared>,
  ): ResolvedToolSnapshot<
    TTools,
    ApplySituationPartition<P, Sit[Name]>,
    [
      ApplySituationPartition<P, Sit[Name]>['conditional'],
    ] extends [
      never,
    ]
      ? ApplySituationPartition<P, Sit[Name]>['enabled']
      :
          | ApplySituationPartition<P, Sit[Name]>['enabled']
          | ApplySituationPartition<P, Sit[Name]>['conditional']
  > {
    const situation = this.#situations.get(name);
    if (!situation) {
      throw new Error(`Unknown situation: "${String(name)}"`);
    }

    const activation = cloneActivationMap(this.#activation);
    for (const id of situation.enabled) {
      activation.set(id, {
        kind: 'static',
        active: true,
        source: 'situation',
      });
    }
    for (const id of situation.disabled) {
      activation.set(id, {
        kind: 'static',
        active: false,
        source: 'situation',
      });
    }
    for (const entry of situation.conditional) {
      activation.set(entry.id, {
        kind: entry.mode,
        predicate: entry.predicate,
        source: 'situation',
      });
    }

    return this.#resolveWithActivation(activation, input) as unknown as ResolvedToolSnapshot<
      TTools,
      ApplySituationPartition<P, Sit[Name]>,
      [
        ApplySituationPartition<P, Sit[Name]>['conditional'],
      ] extends [
        never,
      ]
        ? ApplySituationPartition<P, Sit[Name]>['enabled']
        :
            | ApplySituationPartition<P, Sit[Name]>['enabled']
            | ApplySituationPartition<P, Sit[Name]>['conditional']
    >;
  }

  #resolveWithActivation(
    activation: Map<string, ActivationEntry<TShared>>,
    input?: ActivationInput<TShared>,
  ): {
    tools: Tool[];
    activeTools: string[];
    callModel: {
      tools: Tool[];
      activeTools: string[];
    };
    enabled: string[];
    disabled: string[];
    statusByTool: Record<string, ToolStatusEntry>;
  } {
    const resolvedInput: ActivationInput<TShared> = input ?? {};
    const tools: Tool[] = [];
    const activeTools: string[] = [];
    const enabled: string[] = [];
    const disabled: string[] = [];
    const statusByTool: Record<string, ToolStatusEntry> = {};

    for (const id of this.#index.orderedIds) {
      const tool = this.#index.toolById.get(id);
      if (!tool) {
        continue;
      }

      const { active, entry } = this.#evaluate(id, activation, resolvedInput);
      const status = this.#toStatusEntry(active, entry);
      statusByTool[id] = status;

      if (active) {
        tools.push(tool);
        enabled.push(id);
        if (!isServerTool(tool)) {
          activeTools.push(id);
        }
      } else {
        disabled.push(id);
      }
    }

    return {
      tools,
      activeTools,
      callModel: {
        tools,
        activeTools,
      },
      enabled,
      disabled,
      statusByTool,
    };
  }

  #evaluate(
    id: string,
    activation: Map<string, ActivationEntry<TShared>>,
    input: ActivationInput<TShared>,
  ): {
    active: boolean;
    entry: ActivationEntry<TShared> | undefined;
  } {
    const entry = activation.get(id);
    if (!entry) {
      return {
        active: true,
        entry: undefined,
      };
    }
    if (entry.kind === 'static') {
      return {
        active: entry.active,
        entry,
      };
    }
    if (entry.kind === 'activateWhen') {
      return {
        active: entry.predicate(input) === true,
        entry,
      };
    }
    return {
      active: entry.predicate(input) !== true,
      entry,
    };
  }

  #toStatusEntry(active: boolean, entry: ActivationEntry<TShared> | undefined): ToolStatusEntry {
    if (!entry) {
      return {
        enabled: active,
        reason: 'default',
      };
    }

    if (entry.kind === 'static') {
      const directive = entry.active ? ('activate' as const) : ('deactivate' as const);
      const reason: StatusReason =
        entry.source === 'situation'
          ? 'situation'
          : entry.source === 'default'
            ? 'default'
            : directive;
      return {
        enabled: active,
        reason,
        directive,
      };
    }

    const directive = entry.kind;
    const reason: StatusReason = entry.source === 'situation' ? 'situation' : directive;
    return {
      enabled: active,
      reason,
      directive,
      predicate: true,
    };
  }

  clone(opts?: { mutable?: boolean }): ToolSet<TTools, TShared, P, Sit> {
    return new ToolSet<TTools, TShared, P, Sit>(
      this.#index,
      cloneActivationMap(this.#activation),
      cloneSituationsMap(this.#situations),
      opts?.mutable ?? this.#mutable,
    );
  }
}

export function createToolSet<
  const T extends readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, unknown>,
>(opts: {
  tools: T;
  mutable?: boolean;
}): ToolSet<T, TShared, InitialPartition<T>, EmptySituations> {
  return ToolSet.create<T, TShared>({
    tools: opts.tools,
    ...(opts.mutable !== undefined && {
      mutable: opts.mutable,
    }),
  });
}

// Re-export commonly needed type helpers used at call sites without a separate import.
export type {
  ClientToolNamesOfTuple,
  FilterToolsByIds,
  ServerToolIdsOfTuple,
  ToolIdOf,
  ToolIdsOfTuple,
};
