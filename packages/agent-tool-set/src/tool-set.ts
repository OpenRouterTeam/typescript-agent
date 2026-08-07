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
  WidenedPartition,
  WidenedSituationMap,
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
 * Selects the return type of a mutator call.
 *
 * A mutable `ToolSet` mutates one shared runtime object in place, and any
 * number of aliases can reference that object. If a mutator refined `P`/`Sit`
 * on a mutable instance the way the immutable path does, two aliases of the
 * *same* live object could statically claim different, contradictory exact
 * types the instant either one mutated — unsound, since both aliases still
 * point at the one object whose actual state matches only the latest call.
 *
 * When `TMutable extends true`, mutators therefore return the receiver's own
 * unchanged type (`ToolSet<TTools, TShared, P, Sit, true>`) instead of a
 * refined `NextP`/`NextSit` — every alias of a mutable instance keeps the
 * exact same (already maximally conservative) static type for its whole
 * lifetime, so no alias can ever contradict another. Immutable instances
 * (`TMutable extends false`) are unaffected: each mutation still returns a
 * brand-new object with the precisely refined `NextP`/`NextSit`, exactly as
 * before.
 */
type Mutated<
  TTools extends readonly Tool[],
  TShared extends Record<string, unknown>,
  P extends Partition,
  Sit extends SituationMap,
  TMutable extends boolean,
  NextP extends Partition,
  NextSit extends SituationMap = Sit,
> = TMutable extends true
  ? ToolSet<TTools, TShared, P, Sit, true>
  : ToolSet<TTools, TShared, NextP, NextSit, false>;

/**
 * Immutable-by-default stateful set of tools with a three-way static
 * partition (enabled / disabled / conditional) and optional named situations.
 *
 * @typeParam TTools - Concrete ordered tools tuple
 * @typeParam TShared - Shared context shape for predicates
 * @typeParam P - Compile-time partition of tool-set IDs
 * @typeParam Sit - Named situation registry
 * @typeParam TMutable - Whether this instance mutates in place. Mutable
 *   instances deliberately carry a single widened `P`/`Sit` for their entire
 *   lifetime (see {@link Mutated}) so that every alias stays sound; immutable
 *   instances keep the exact, precisely-refined `P`/`Sit` per instance.
 */
export class ToolSet<
  TTools extends readonly Tool[] = readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, unknown>,
  P extends Partition = InitialPartition<TTools>,
  Sit extends SituationMap = EmptySituations,
  TMutable extends boolean = false,
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
  >(opts: {
    tools: T;
    mutable: true;
  }): ToolSet<T, S, WidenedPartition<T>, WidenedSituationMap, true>;
  static create<
    T extends readonly Tool[],
    S extends Record<string, unknown> = Record<string, unknown>,
  >(opts: {
    tools: T;
    mutable?: false;
  }): ToolSet<T, S, InitialPartition<T>, EmptySituations, false>;
  static create<
    T extends readonly Tool[],
    S extends Record<string, unknown> = Record<string, unknown>,
  >(opts: {
    tools: T;
    mutable?: boolean;
  }):
    | ToolSet<T, S, WidenedPartition<T>, WidenedSituationMap, true>
    | ToolSet<T, S, InitialPartition<T>, EmptySituations, false> {
    const mutable = opts.mutable ?? false;
    if (mutable) {
      return new ToolSet<T, S, WidenedPartition<T>, WidenedSituationMap, true>(
        indexTools(opts.tools),
        new Map(),
        new Map(),
        true,
      );
    }
    return new ToolSet<T, S, InitialPartition<T>, EmptySituations, false>(
      indexTools(opts.tools),
      new Map(),
      new Map(),
      false,
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
  ): Mutated<TTools, TShared, P, Sit, TMutable, NextP> {
    if (this.#mutable) {
      // Mutable mode mutates the shared runtime object in place and returns
      // `this` unchanged: every alias of a mutable instance already carries
      // the same widened `P`/`Sit`, so returning that same (unrefined) type
      // here — instead of a freshly refined `NextP` — keeps all aliases
      // statically consistent with the one object they actually reference.
      mutate(this.#activation);
      return this as unknown as Mutated<TTools, TShared, P, Sit, TMutable, NextP>;
    }
    const nextActivation = cloneActivationMap(this.#activation);
    mutate(nextActivation);
    return new ToolSet<TTools, TShared, NextP, Sit, false>(
      this.#index,
      nextActivation,
      this.#situations,
      false,
    ) as unknown as Mutated<TTools, TShared, P, Sit, TMutable, NextP>;
  }

  activate<const N extends ToolIdsOfTuple<TTools>>(
    names: N | readonly N[],
  ): Mutated<TTools, TShared, P, Sit, TMutable, ActivatePartition<P, N>> {
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
  ): Mutated<TTools, TShared, P, Sit, TMutable, DeactivatePartition<P, N>> {
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
  ): Mutated<TTools, TShared, P, Sit, TMutable, ConditionalPartition<P, N>>;
  activateWhen<const N extends ToolIdsOfTuple<TTools>>(
    map: {
      readonly [K in N]?: ActivationPredicate<TShared>;
    },
  ): Mutated<TTools, TShared, P, Sit, TMutable, ConditionalPartition<P, N>>;
  activateWhen<const N extends ToolIdsOfTuple<TTools>>(
    nameOrMap:
      | N
      | {
          readonly [K in N]?: ActivationPredicate<TShared>;
        },
    predicate?: ActivationPredicate<TShared>,
  ): Mutated<TTools, TShared, P, Sit, TMutable, ConditionalPartition<P, N>> {
    const entries = this.#normalizePredicateArg(
      nameOrMap as string | Partial<Record<string, ActivationPredicate<TShared>>>,
      predicate,
    );
    return this.#withPartitionMutation<ConditionalPartition<P, N>>((activation) => {
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
  ): Mutated<TTools, TShared, P, Sit, TMutable, ConditionalPartition<P, N>>;
  deactivateWhen<const N extends ToolIdsOfTuple<TTools>>(
    map: {
      readonly [K in N]?: ActivationPredicate<TShared>;
    },
  ): Mutated<TTools, TShared, P, Sit, TMutable, ConditionalPartition<P, N>>;
  deactivateWhen<const N extends ToolIdsOfTuple<TTools>>(
    nameOrMap:
      | N
      | {
          readonly [K in N]?: ActivationPredicate<TShared>;
        },
    predicate?: ActivationPredicate<TShared>,
  ): Mutated<TTools, TShared, P, Sit, TMutable, ConditionalPartition<P, N>> {
    const entries = this.#normalizePredicateArg(
      nameOrMap as string | Partial<Record<string, ActivationPredicate<TShared>>>,
      predicate,
    );
    return this.#withPartitionMutation<ConditionalPartition<P, N>>((activation) => {
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
  >(situations: M): Mutated<TTools, TShared, P, Sit, TMutable, P, InferSituationMap<M>> {
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
      // Same rationale as #withPartitionMutation: `this` keeps its existing
      // (already widened) static type instead of claiming a freshly refined
      // `InferSituationMap<M>`, so every alias stays statically consistent.
      this.#situations.clear();
      for (const [k, v] of next) {
        this.#situations.set(k, v);
      }
      return this as unknown as Mutated<TTools, TShared, P, Sit, TMutable, P, InferSituationMap<M>>;
    }

    return new ToolSet<TTools, TShared, P, InferSituationMap<M>, false>(
      this.#index,
      cloneActivationMap(this.#activation),
      next,
      false,
    ) as unknown as Mutated<TTools, TShared, P, Sit, TMutable, P, InferSituationMap<M>>;
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
   *
   * Returns the full snapshot, including metadata (`enabled`, `disabled`,
   * `statusByTool`) that is not a valid `callModel` input. Only `tools` and
   * `activeTools` are meant to reach `callModel` — spread those two fields
   * (or use `resolve(...).callModel`, which contains exactly them),
   * not the whole return value of this method:
   *
   * ```ts
   * const { tools, activeTools } = toolSet.inferTools();
   * callModel(client, { model, input, tools, activeTools });
   * ```
   *
   * `callModel` also defensively strips `enabled` / `disabled` /
   * `statusByTool` (and a top-level `callModel` key) from whatever it's
   * given, so spreading this method's full result is safe too — but the
   * two-field pattern above is the documented, minimal contract.
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
    // Object.create(null), not `{}`: tool IDs are caller-supplied strings
    // (serverTool only rejects the empty string), so `__proto__` is a valid
    // ID. Assigning `statusByTool['__proto__'] = ...` on a `{}` object would
    // invoke the inherited setter and reassign the object's prototype
    // instead of creating an own property, silently dropping that ID from
    // the exhaustive map. Same reasoning as extractServerToolIdentity in
    // packages/agent/src/lib/model-result.ts and the subset builder in
    // packages/agent/src/lib/doom-loop.ts.
    const statusByTool: Record<string, ToolStatusEntry> = Object.create(null) as Record<
      string,
      ToolStatusEntry
    >;

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

  /**
   * Copy state into a fresh, independent instance.
   *
   * Flipping to `mutable: true` starts a *new* mutation lifetime, so — like
   * `ToolSet.create({ mutable: true })` — the clone's partition/situations
   * widen to {@link WidenedPartition}/{@link WidenedSituationMap} rather than
   * inheriting the source's exact `P`/`Sit`: an exact type could otherwise be
   * invalidated the moment the clone is mutated, while other clones or the
   * original remain unaffected. Cloning without flipping mode (mode
   * inherited, including an already-mutable source) or flipping to `false`
   * keeps the source's `P`/`Sit` unchanged.
   */
  clone(opts?: { mutable?: undefined }): ToolSet<TTools, TShared, P, Sit, TMutable>;
  clone(opts: {
    mutable: true;
  }): ToolSet<TTools, TShared, WidenedPartition<TTools>, WidenedSituationMap, true>;
  clone(opts: { mutable: false }): ToolSet<TTools, TShared, P, Sit, false>;
  clone(
    opts?:
      | {
          mutable?: undefined;
        }
      | {
          mutable: true;
        }
      | {
          mutable: false;
        },
  ):
    | ToolSet<TTools, TShared, P, Sit, TMutable>
    | ToolSet<TTools, TShared, WidenedPartition<TTools>, WidenedSituationMap, true>
    | ToolSet<TTools, TShared, P, Sit, false> {
    const mutable = opts?.mutable ?? this.#mutable;
    if (opts?.mutable === true && !this.#mutable) {
      return new ToolSet<TTools, TShared, WidenedPartition<TTools>, WidenedSituationMap, true>(
        this.#index,
        cloneActivationMap(this.#activation),
        cloneSituationsMap(this.#situations),
        true,
      );
    }
    return new ToolSet<TTools, TShared, P, Sit, boolean>(
      this.#index,
      cloneActivationMap(this.#activation),
      cloneSituationsMap(this.#situations),
      mutable,
    ) as ToolSet<TTools, TShared, P, Sit, TMutable>;
  }
}

/**
 * Construct a {@link ToolSet}.
 *
 * `mutable: true` deliberately returns a widened partition/situations type
 * (`WidenedPartition`/`WidenedSituationMap`) rather than the exact
 * `InitialPartition`/`EmptySituations` used by the default immutable mode —
 * see {@link Mutated} for why mutable instances need this from construction
 * onward. Omitting `mutable` (or passing `false`) keeps today's exact,
 * precisely-refined immutable partition tracking unchanged.
 */
export function createToolSet<
  const T extends readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, unknown>,
>(opts: {
  tools: T;
  mutable: true;
}): ToolSet<T, TShared, WidenedPartition<T>, WidenedSituationMap, true>;
export function createToolSet<
  const T extends readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, unknown>,
>(opts: {
  tools: T;
  mutable?: false;
}): ToolSet<T, TShared, InitialPartition<T>, EmptySituations, false>;
export function createToolSet<
  const T extends readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, unknown>,
>(opts: {
  tools: T;
  mutable?: boolean;
}):
  | ToolSet<T, TShared, WidenedPartition<T>, WidenedSituationMap, true>
  | ToolSet<T, TShared, InitialPartition<T>, EmptySituations, false> {
  if (opts.mutable) {
    return ToolSet.create<T, TShared>({
      tools: opts.tools,
      mutable: true,
    });
  }
  return ToolSet.create<T, TShared>({
    tools: opts.tools,
    mutable: false,
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
