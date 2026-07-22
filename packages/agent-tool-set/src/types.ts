import type {
  ClientTool,
  ConversationState,
  CorrelatedToolEventUnion,
  ServerToolBase,
  Tool,
} from '@openrouter/agent';

// ─── identity ───────────────────────────────────────────────────────────────

/** Client tool: `function.name` literal. */
export type ClientToolName<T> = T extends {
  function: {
    name: infer N extends string;
  };
}
  ? N
  : never;

/**
 * Server-tool stable ID.
 * Prefixed so it can never collide with a client function name.
 * Prefers an explicit `id` on the tool; falls back to `server:${config.type}`.
 */
export type ServerToolIdOf<T> = T extends {
  readonly id: infer Id extends string;
}
  ? string extends Id
    ? T extends {
        readonly config: {
          type: infer K extends string;
        };
      }
      ? `server:${K}`
      : never
    : Id
  : T extends {
        readonly config: {
          type: infer K extends string;
        };
      }
    ? `server:${K}`
    : never;

/** Union of every addressable id for one tool. */
export type ToolIdOf<T extends Tool> = T extends ServerToolBase
  ? ServerToolIdOf<T>
  : ClientToolName<T>;

export type ToolIdsOfTuple<T extends readonly Tool[]> = ToolIdOf<T[number]>;

export type ClientToolNamesOfTuple<T extends readonly Tool[]> = ClientToolName<
  Extract<T[number], ClientTool>
>;

export type ServerToolIdsOfTuple<T extends readonly Tool[]> = ServerToolIdOf<
  Extract<T[number], ServerToolBase>
>;

/** Lookup tool by id inside a tuple (preserves concrete member type). */
export type ToolById<T extends readonly Tool[], Id extends string> = Extract<
  {
    [I in keyof T]: T[I] extends Tool ? (ToolIdOf<T[I]> extends Id ? T[I] : never) : never;
  }[number],
  Tool
>;

/** Keep tuple order; drop members whose id is not in Active. */
export type FilterToolsByIds<
  T extends readonly Tool[],
  Active extends string,
> = T extends readonly [
  infer H extends Tool,
  ...infer R extends readonly Tool[],
]
  ? ToolIdOf<H> extends Active
    ? readonly [
        H,
        ...FilterToolsByIds<R, Active>,
      ]
    : FilterToolsByIds<R, Active>
  : readonly [];

// ─── three-way compile-time partition ───────────────────────────────────────

/**
 * Enabled  = statically on (default, or .activate / situation.enabled)
 * Disabled = statically off (.deactivate / situation.disabled)
 * Conditional = runtime predicate (.activateWhen / .deactivateWhen / situation rules)
 *
 * Invariants (enforced by mutators via Exclude):
 *   Enabled ∩ Disabled = ∅
 *   Enabled ∩ Conditional = ∅
 *   Disabled ∩ Conditional = ∅
 *   Enabled ∪ Disabled ∪ Conditional = all known IDs
 */
export type Partition = {
  enabled: string;
  disabled: string;
  conditional: string;
};

export type EmptyPartition = {
  enabled: never;
  disabled: never;
  conditional: never;
};

/** Default construction: every tool ID enabled. */
export type InitialPartition<T extends readonly Tool[]> = {
  enabled: ToolIdsOfTuple<T>;
  disabled: never;
  conditional: never;
};

export type ActivatePartition<P extends Partition, Name extends string> = {
  enabled: P['enabled'] | Name;
  disabled: Exclude<P['disabled'], Name>;
  conditional: Exclude<P['conditional'], Name>;
};

export type DeactivatePartition<P extends Partition, Name extends string> = {
  enabled: Exclude<P['enabled'], Name>;
  disabled: P['disabled'] | Name;
  conditional: Exclude<P['conditional'], Name>;
};

export type ConditionalPartition<P extends Partition, Name extends string> = {
  enabled: Exclude<P['enabled'], Name>;
  disabled: Exclude<P['disabled'], Name>;
  conditional: P['conditional'] | Name;
};

// ─── activation input ───────────────────────────────────────────────────────

export type ActivationInput<TShared extends Record<string, unknown> = Record<string, unknown>> = {
  state?: ConversationState;
  context?: TShared;
};

export type ActivationPredicate<TShared extends Record<string, unknown> = Record<string, unknown>> =
  (input: ActivationInput<TShared>) => boolean;

// ─── situations ─────────────────────────────────────────────────────────────

export type SituationConditionalRule<
  TShared extends Record<string, unknown> = Record<string, unknown>,
> =
  | ActivationPredicate<TShared>
  | {
      mode?: 'activateWhen' | 'deactivateWhen';
      predicate: ActivationPredicate<TShared>;
    };

/**
 * Declarative fixed partition overlay for one named situation.
 * Keys not listed keep the base ToolSet partition after the overlay.
 */
export type SituationConfig<
  TIds extends string = string,
  TShared extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** Statically on in this situation. */
  enabled?: readonly TIds[];
  /** Statically off in this situation. */
  disabled?: readonly TIds[];
  /**
   * Conditional tools for this situation.
   * Default mode is activateWhen (inactive until predicate is true).
   * Use `{ mode: 'deactivateWhen', predicate }` for the reverse default.
   */
  conditional?: {
    readonly [K in TIds]?: SituationConditionalRule<TShared>;
  };
};

/** Situations registry accumulated on the ToolSet type. */
export type SituationMap = Record<
  string,
  {
    enabled: string;
    disabled: string;
    conditional: string;
  }
>;

export type EmptySituations = Record<never, never>;

export type SituationNames<S extends SituationMap> = keyof S & string;

/**
 * Infer the static partition contribution of a situation config object.
 * Missing fields contribute `never`.
 */
export type InferSituationEntry<C> = {
  enabled: C extends {
    enabled: readonly (infer E extends string)[];
  }
    ? E
    : never;
  disabled: C extends {
    disabled: readonly (infer D extends string)[];
  }
    ? D
    : never;
  conditional: C extends {
    conditional: infer Cond;
  }
    ? keyof Cond & string
    : never;
};

export type InferSituationMap<M> = {
  [K in keyof M]: InferSituationEntry<M[K]>;
};

/**
 * Apply a situation overlay onto a base partition.
 * Situation wins for every id it mentions; others stay from base.
 */
export type ApplySituationPartition<
  Base extends Partition,
  Sit extends {
    enabled: string;
    disabled: string;
    conditional: string;
  },
> = {
  enabled:
    | Exclude<Base['enabled'], Sit['enabled'] | Sit['disabled'] | Sit['conditional']>
    | Sit['enabled'];
  disabled:
    | Exclude<Base['disabled'], Sit['enabled'] | Sit['disabled'] | Sit['conditional']>
    | Sit['disabled'];
  conditional:
    | Exclude<Base['conditional'], Sit['enabled'] | Sit['disabled'] | Sit['conditional']>
    | Sit['conditional'];
};

// ─── runtime resolved snapshot (exhaustive) ─────────────────────────────────

export type StatusReason =
  | 'default'
  | 'activate'
  | 'deactivate'
  | 'activateWhen'
  | 'deactivateWhen'
  | 'situation';

export type ToolStatusEntry = {
  readonly enabled: boolean;
  readonly reason: StatusReason;
  /**
   * The last applicable directive for this tool before predicates ran, if any.
   * Absent when the tool is still at its construction default.
   */
  readonly directive?: 'activate' | 'deactivate' | 'activateWhen' | 'deactivateWhen';
  /** True when the final state depended on evaluating a runtime predicate. */
  readonly predicate?: boolean;
};

export type StatusByToolMap<TIds extends string> = {
  readonly [K in TIds]: ToolStatusEntry;
};

/**
 * What resolve() / resolveSituation() returns.
 *
 * For static-only partitions (`conditional = never`), TActive is exactly
 * `P['enabled']` and the snapshot is fully known at compile time.
 * When conditional ≠ never, TActive is the sound upper bound
 * `P['enabled'] | P['conditional']`; runtime arrays/status are exact.
 */
export type ResolvedToolSnapshot<
  TTools extends readonly Tool[],
  P extends Partition,
  TActive extends string = P['enabled'] | P['conditional'],
> = {
  /** Active tools only, construction order preserved, concrete member types kept. */
  readonly tools: FilterToolsByIds<TTools, TActive & ToolIdsOfTuple<TTools>>;
  /** Active client names only (`callModel.activeTools` wire format). Server ids omitted. */
  readonly activeTools: readonly Extract<TActive, ClientToolNamesOfTuple<TTools>>[];
  /** Spread-safe input for `callModel`; snapshot metadata is intentionally excluded. */
  readonly callModel: {
    readonly tools: FilterToolsByIds<TTools, TActive & ToolIdsOfTuple<TTools>>;
    readonly activeTools: readonly Extract<TActive, ClientToolNamesOfTuple<TTools>>[];
  };
  /** IDs that resolved active (client + server). */
  readonly enabled: readonly (TActive & ToolIdsOfTuple<TTools>)[];
  /** IDs that resolved inactive. */
  readonly disabled: readonly Exclude<ToolIdsOfTuple<TTools>, TActive & ToolIdsOfTuple<TTools>>[];
  /** Exhaustive id → status entry. Every ToolIdsOfTuple key present. */
  readonly statusByTool: StatusByToolMap<ToolIdsOfTuple<TTools>>;
};

// ─── ToolSet structural eraser + inference utilities ────────────────────────

/**
 * Structural shape for extracting partition/situation generics from either
 * mutable or immutable `ToolSet` instances.
 */
export type ToolSetLike<
  TTools extends readonly Tool[] = readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, unknown>,
  P extends Partition = Partition,
  Sit extends SituationMap = SituationMap,
> = {
  readonly tools: TTools;
  readonly _partition?: P;
  readonly _situations?: Sit;
  readonly _shared?: TShared;
};

/** Every known tool-set ID. */
export type InferAllIds<TS> =
  TS extends ToolSetLike<infer T, any, any, any> ? ToolIdsOfTuple<T> : never;

/** Definitely-enabled IDs (static). */
export type InferEnabledIds<TS> =
  TS extends ToolSetLike<any, any, infer P, any> ? P['enabled'] : never;

/** Definitely-disabled IDs (static). */
export type InferDisabledIds<TS> =
  TS extends ToolSetLike<any, any, infer P, any> ? P['disabled'] : never;

/** Conditionally-activated IDs (runtime predicate). */
export type InferConditionalIds<TS> =
  TS extends ToolSetLike<any, any, infer P, any> ? P['conditional'] : never;

/**
 * Name-correlated streaming events for a tools tuple.
 * Delegates to the agent's core {@link CorrelatedToolEventUnion}.
 */
export type InferToolSet<T extends readonly Tool[]> = CorrelatedToolEventUnion<T>;
