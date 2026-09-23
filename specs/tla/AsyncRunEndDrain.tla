---------------------------- MODULE AsyncRunEndDrain ----------------------------
(*
 * Model of ModelResult.handleRunEndAsyncTasks (onRunEnd: 'drain') together
 * with AsyncToolRegistry settlement, for background tool tasks that outlived
 * their grace window and hold a pending placeholder in the transcript.
 *
 * Every JavaScript synchronous section is one atomic step. Background work
 * settles at any await boundary (Settle action), which is exactly what the
 * registry's `.then()` callbacks do at runtime.
 *
 * Property checked: when the run ends, every task that settled has been
 * accounted for, either delivered in a drain turn or dropped and persisted by
 * dropSettledTasks. The registry's settled queue is empty at run end.
 *)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Tasks,          \* set of background tasks with a pending placeholder
  MaxDrainTurns,  \* asyncTools.maxDrainTurns
  DrainTimeouts,  \* TRUE: drainTimeoutMs may expire (registry.drain returns false)
  FixDropLeftover \* TRUE: run end drops unharvested settlements even with nothing in flight

VARIABLES
  status,     \* task -> "working" | "settled"
  queued,     \* task -> BOOLEAN, settlement sits in registry.settledQueue
  outcome,    \* task -> "none" | "delivered" | "dropped"
  pc,         \* program counter of handleRunEndAsyncTasks
  drainTurn,  \* loop counter
  harvested,  \* tasks taken by the current flushAsyncToolDeliveries
  deadlinePassed

vars == <<status, queued, outcome, pc, drainTurn, harvested, deadlinePassed>>

InFlight == \E t \in Tasks : status[t] = "working"
Unharvested == \E t \in Tasks : queued[t]

TypeOK ==
  /\ status \in [Tasks -> {"working", "settled"}]
  /\ queued \in [Tasks -> BOOLEAN]
  /\ outcome \in [Tasks -> {"none", "delivered", "dropped"}]
  /\ pc \in {"start", "loopTop", "awaitDrain", "harvest", "modelTurn", "afterTurn",
             "finalize", "done"}
  /\ drainTurn \in 0..MaxDrainTurns
  /\ harvested \subseteq Tasks
  /\ deadlinePassed \in BOOLEAN

Init ==
  /\ status = [t \in Tasks |-> "working"]
  /\ queued = [t \in Tasks |-> FALSE]
  /\ outcome = [t \in Tasks |-> "none"]
  /\ pc = "start"
  /\ drainTurn = 0
  /\ harvested = {}
  /\ deadlinePassed = FALSE

\* Background work resolves or rejects: registry.settle pushes onto settledQueue.
Settle(t) ==
  /\ status[t] = "working"
  /\ pc # "done"
  /\ status' = [status EXCEPT ![t] = "settled"]
  /\ queued' = [queued EXCEPT ![t] = TRUE]
  /\ UNCHANGED <<outcome, pc, drainTurn, harvested, deadlinePassed>>

\* Wall clock: drainTimeoutMs elapses at some point.
Deadline ==
  /\ DrainTimeouts
  /\ ~deadlinePassed
  /\ deadlinePassed' = TRUE
  /\ UNCHANGED <<status, queued, outcome, pc, drainTurn, harvested>>

\* Early return: nothing in flight and nothing unharvested.
Start ==
  /\ pc = "start"
  /\ pc' = IF ~InFlight /\ ~Unharvested THEN "done" ELSE "loopTop"
  /\ UNCHANGED <<status, queued, outcome, drainTurn, harvested, deadlinePassed>>

LoopTop ==
  /\ pc = "loopTop"
  /\ pc' = IF drainTurn >= MaxDrainTurns THEN "finalize"
           ELSE IF ~Unharvested /\ InFlight
                THEN IF deadlinePassed THEN "finalize" ELSE "awaitDrain"
                ELSE "harvest"
  /\ UNCHANGED <<status, queued, outcome, drainTurn, harvested, deadlinePassed>>

\* registry.drain(remaining) resumes on a settle event or on timeout.
AwaitDrain ==
  /\ pc = "awaitDrain"
  /\ (Unharvested \/ deadlinePassed \/ ~InFlight)
  /\ pc' = "harvest"
  /\ UNCHANGED <<status, queued, outcome, drainTurn, harvested, deadlinePassed>>

\* flushAsyncToolDeliveries: takeSettled(), inject envelope. Nothing settled: stop.
Harvest ==
  /\ pc = "harvest"
  /\ LET taken == {t \in Tasks : queued[t]}
     IN /\ harvested' = taken
        /\ queued' = [t \in Tasks |-> FALSE]
        /\ outcome' = [t \in Tasks |-> IF t \in taken THEN "delivered" ELSE outcome[t]]
        /\ pc' = IF taken = {} THEN "finalize" ELSE "modelTurn"
  /\ UNCHANGED <<status, drainTurn, deadlinePassed>>

\* retryCurrentRequest + saveResponseToState (awaits, tasks may settle meanwhile).
ModelTurn ==
  /\ pc = "modelTurn"
  /\ pc' = "afterTurn"
  /\ UNCHANGED <<status, queued, outcome, drainTurn, harvested, deadlinePassed>>

AfterTurn ==
  /\ pc = "afterTurn"
  /\ drainTurn' = drainTurn + 1
  /\ pc' = IF ~InFlight /\ ~Unharvested THEN "finalize" ELSE "loopTop"
  /\ UNCHANGED <<status, queued, outcome, harvested, deadlinePassed>>

\* Drain budget exhausted: abortAll settles working tasks as cancelled, then
\* dropSettledTasks persists every queued settlement. In the unfixed code the
\* drop only runs when something was still in flight.
Finalize ==
  /\ pc = "finalize"
  /\ LET drops == InFlight \/ FixDropLeftover
         settledNow == [t \in Tasks |-> "settled"]
         queuedNow == [t \in Tasks |-> queued[t] \/ status[t] = "working"]
     IN IF InFlight
        THEN /\ status' = settledNow
             /\ queued' = [t \in Tasks |-> FALSE]
             /\ outcome' = [t \in Tasks |-> IF queuedNow[t] THEN "dropped" ELSE outcome[t]]
        ELSE IF drops
             THEN /\ status' = status
                  /\ queued' = [t \in Tasks |-> FALSE]
                  /\ outcome' = [t \in Tasks |-> IF queued[t] THEN "dropped" ELSE outcome[t]]
             ELSE UNCHANGED <<status, queued, outcome>>
  /\ pc' = "done"
  /\ UNCHANGED <<drainTurn, harvested, deadlinePassed>>

Terminating == pc = "done" /\ UNCHANGED vars

Next ==
  \/ \E t \in Tasks : Settle(t)
  \/ Deadline
  \/ Start \/ LoopTop \/ AwaitDrain \/ Harvest \/ ModelTurn \/ AfterTurn \/ Finalize
  \/ Terminating

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

\* Every settlement is delivered or persisted by the time the run returns.
NoLeakedSettlement ==
  pc = "done" => \A t \in Tasks : ~queued[t] /\ (status[t] = "settled" => outcome[t] # "none")

\* Delivery happens at most once and only for settled tasks.
DeliveryConsistent ==
  \A t \in Tasks : outcome[t] # "none" => status[t] = "settled"

Safety == TypeOK /\ NoLeakedSettlement /\ DeliveryConsistent

EventuallyDone == <>(pc = "done")

=============================================================================
