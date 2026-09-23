-------------------------- MODULE MultiConsumerStream --------------------------
(*
 * Model of the multi-consumer buffer shared by
 *   packages/agent/src/lib/reusable-stream.ts        (ReusableReadableStream)
 *   packages/agent/src/lib/tool-event-broadcaster.ts (ToolEventBroadcaster)
 *
 * One producer ("pump") appends values to a buffer.  Consumers hold an
 * absolute position; the buffer index of a consumer is
 *   head + position - trim
 * Consumers that find nothing to read install a waiting promise and resume
 * later (a separate atomic step, since resumption is a microtask).  In
 * 'active-consumers' replay mode the buffer is trimmed to the slowest live
 * consumer, and the retained backlog is dropped when the last consumer
 * leaves.  ReusableReadableStream.cancel() is a two-phase operation with an
 * await in the middle; both phases are modelled.
 *
 * Atomicity follows JavaScript: every synchronous section between two
 * awaits is one action.
 *)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
  Variant,            \* "stream" (ReusableReadableStream) | "broadcaster" (ToolEventBroadcaster)
  Consumers,          \* set of consumer ids
  MaxValues,          \* bound on values the pump produces
  Mode,               \* "full" | "active"
  CompactionMinHead,  \* BUFFER_COMPACTION_MIN_HEAD (1024 in code; small here)
  AllowStreamCancel,  \* model ReusableReadableStream.cancel()
  AllowLateCreate,    \* allow createConsumer() after cancel() started
  CancelledFlag       \* fix: createConsumer() after cancel() registers nothing

ASSUME Mode \in {"full", "active"}
ASSUME Variant \in {"stream", "broadcaster"}
ASSUME Variant = "broadcaster" => ~AllowStreamCancel

CLEARED == 0   \* `undefined` slot left by buffer.fill(undefined, ...)

VARIABLES
  buf,        \* Seq of values (1..MaxValues) or CLEARED
  head,       \* bufferHead
  trim,       \* trimOffset
  produced,   \* number of values pushed so far
  complete,   \* sourceComplete / isComplete
  err,        \* sourceError / completionError set
  nextId,     \* nextConsumerId (only used for the `=== 0` check)
  pump,       \* "running" | "done"
  cons,       \* consumer records
  pc,         \* consumer program counters
  recv,       \* values received by each consumer
  joinPos,    \* position at createConsumer()
  joinedLate, \* createConsumer() happened after completion
  cancelPhase, \* "none" | "awaitingSource" | "done"
  cleanupPending \* broadcaster: queueMicrotask(() => this.cleanup()) outstanding

vars == <<buf, head, trim, produced, complete, err, nextId, pump, cons, pc,
          recv, joinPos, joinedLate, cancelPhase, cleanupPending>>

ConsumerRecord == [inMap: BOOLEAN, pos: Nat, waiting: BOOLEAN,
                   resolved: BOOLEAN, rejected: BOOLEAN]

PCs == {"notStarted", "idle", "waiting", "done", "errored", "cancelled"}

Live(c) == cons[c].inMap

LiveConsumers == {c \in Consumers : Live(c)}

Idx(c) == head + cons[c].pos - trim      \* JS bufferIndex (0-based)

HasUnread(c) == Idx(c) < Len(buf)          \* JS: bufferIndex < buffer.length

------------------------------------------------------------------------------
(* Helpers mirroring the private methods *)

\* dropUnreadBacklog(): returns [buf, head, trim]
DropUnreadBacklog(b, h, t, nid) ==
  IF nid = 0 \/ Len(b) - h = 0
    THEN <<b, h, t>>
    ELSE <<<<>>, 0, t + (Len(b) - h)>>

Min(S) == CHOOSE m \in S : \A x \in S : m <= x

\* trimConsumed() given the consumer map `cs`; returns [buf, head, trim]
TrimConsumed(b, h, t, cs, nid) ==
  IF Mode = "full" THEN <<b, h, t>>
  ELSE
    LET live == {c \in Consumers : cs[c].inMap}
    IN IF live = {} THEN DropUnreadBacklog(b, h, t, nid)
       ELSE
         LET m == Min({cs[c].pos : c \in live})
             nextHead == h + m - t
         IN IF nextHead <= h THEN <<b, h, t>>
            ELSE IF nextHead = Len(b) THEN <<<<>>, 0, m>>
            ELSE
              LET filled == [i \in 1..Len(b) |->
                               IF i > h /\ i <= nextHead THEN CLEARED ELSE b[i]]
              IN IF nextHead >= CompactionMinHead /\ nextHead * 2 >= Len(b)
                   THEN <<SubSeq(filled, nextHead + 1, Len(filled)), 0, m>>
                   ELSE <<filled, nextHead, m>>

\* ToolEventBroadcaster.cleanup(): drop the buffer once complete with no
\* consumers left (active-consumers mode only). Note: trimOffset is NOT
\* advanced here, unlike dropUnreadBacklog().
Cleanup(b, h, cs, isComplete) ==
  IF Variant = "broadcaster" /\ Mode = "active" /\ isComplete
     /\ {c \in Consumers : cs[c].inMap} = {}
    THEN <<<<>>, 0>>
    ELSE <<b, h>>

\* notifyAllConsumers(): resolve or reject every waiting promise
Notify(cs, isErr) ==
  [c \in Consumers |->
     IF cs[c].inMap /\ cs[c].waiting
       THEN [cs[c] EXCEPT !.waiting = FALSE,
                          !.resolved = ~isErr,
                          !.rejected = isErr]
       ELSE cs[c]]

------------------------------------------------------------------------------
Init ==
  /\ buf = <<>>
  /\ head = 0
  /\ trim = 0
  /\ produced = 0
  /\ complete = FALSE
  /\ err = FALSE
  /\ nextId = 0
  /\ pump = "running"
  /\ cons = [c \in Consumers |-> [inMap |-> FALSE, pos |-> 0, waiting |-> FALSE,
                                  resolved |-> FALSE, rejected |-> FALSE]]
  /\ pc = [c \in Consumers |-> "notStarted"]
  /\ recv = [c \in Consumers |-> <<>>]
  /\ joinPos = [c \in Consumers |-> 0]
  /\ joinedLate = [c \in Consumers |-> FALSE]
  /\ cancelPhase = "none"
  /\ cleanupPending = FALSE

------------------------------------------------------------------------------
(* Pump *)

\* the stream's pump only starts with the first createConsumer(); the
\* broadcaster is pushed into regardless of consumers.
PumpStarted == Variant = "broadcaster" \/ nextId > 0

Push ==
  /\ pump = "running"
  /\ PumpStarted
  /\ ~complete /\ ~err
  /\ produced < MaxValues
  /\ buf' = Append(buf, produced + 1)
  /\ produced' = produced + 1
  /\ cons' = Notify(cons, FALSE)
  /\ UNCHANGED <<head, trim, complete, err, nextId, pump, pc, recv, joinPos, joinedLate,
                 cancelPhase, cleanupPending>>

Complete ==
  /\ pump = "running"
  /\ PumpStarted
  /\ complete' = TRUE
  /\ pump' = "done"
  /\ cons' = Notify(cons, FALSE)
  /\ cleanupPending' = (Variant = "broadcaster")
  /\ UNCHANGED <<buf, head, trim, produced, err, nextId, pc, recv, joinPos, joinedLate,
                 cancelPhase>>

\* stream: pump error.  broadcaster: complete(error).
Fail ==
  /\ pump = "running"
  /\ PumpStarted
  /\ cancelPhase = "none"
  /\ err' = TRUE
  /\ complete' = (Variant = "broadcaster")
  /\ pump' = "done"
  /\ cons' = Notify(cons, TRUE)
  /\ cleanupPending' = (Variant = "broadcaster")
  /\ UNCHANGED <<buf, head, trim, produced, nextId, pc, recv, joinPos, joinedLate,
                 cancelPhase>>

CleanupMicrotask ==
  /\ cleanupPending
  /\ LET cl == Cleanup(buf, head, cons, complete)
     IN buf' = cl[1] /\ head' = cl[2]
  /\ cleanupPending' = FALSE
  /\ UNCHANGED <<trim, produced, complete, err, nextId, pump, cons, pc, recv,
                 joinPos, joinedLate, cancelPhase>>

------------------------------------------------------------------------------
(* Consumers *)

Create(c) ==
  /\ pc[c] = "notStarted"
  /\ (cancelPhase = "none" \/ AllowLateCreate)
  /\ LET registers == ~(CancelledFlag /\ cancelPhase # "none")
     IN cons' = [cons EXCEPT ![c] = [inMap |-> registers, pos |-> trim, waiting |-> FALSE,
                                     resolved |-> FALSE, rejected |-> FALSE]]
  /\ joinPos' = [joinPos EXCEPT ![c] = trim]
  /\ joinedLate' = [joinedLate EXCEPT ![c] = complete]
  /\ nextId' = nextId + 1
  /\ pc' = [pc EXCEPT ![c] = "idle"]
  /\ UNCHANGED <<buf, head, trim, produced, complete, err, pump, recv, cancelPhase,
                 cleanupPending>>

\* next(): synchronous section
Next(c) ==
  /\ pc[c] = "idle"
  /\ IF ~Live(c) THEN
       \* consumers.get(consumerId) === undefined -> { done: true }
       /\ pc' = [pc EXCEPT ![c] = "done"]
       /\ UNCHANGED <<buf, head, trim, cons, recv>>
     ELSE IF HasUnread(c) THEN
       \* read the slot; a CLEARED slot is the thrown invariant error
       LET v == IF Idx(c) >= 0 THEN buf[Idx(c) + 1] ELSE CLEARED
           cs == [cons EXCEPT ![c].pos = @ + 1]
           tr == TrimConsumed(buf, head, trim, cs, nextId)
       IN
       /\ v # CLEARED
       /\ recv' = [recv EXCEPT ![c] = Append(@, v)]
       /\ cons' = cs
       /\ buf' = tr[1] /\ head' = tr[2] /\ trim' = tr[3]
       /\ UNCHANGED pc
     ELSE IF complete THEN
       LET cs == [cons EXCEPT ![c].inMap = FALSE]
           cl == Cleanup(buf, head, cs, TRUE)
       IN
       /\ cons' = cs
       /\ buf' = cl[1] /\ head' = cl[2]
       /\ pc' = [pc EXCEPT ![c] = IF err THEN "errored" ELSE "done"]
       /\ UNCHANGED <<trim, recv>>
     ELSE IF err THEN
       /\ cons' = [cons EXCEPT ![c].inMap = FALSE]
       /\ pc' = [pc EXCEPT ![c] = "errored"]
       /\ UNCHANGED <<buf, head, trim, recv>>
     ELSE
       \* install waitingPromise; the re-check inside the executor cannot
       \* fire here because the same conditions were just evaluated
       /\ cons' = [cons EXCEPT ![c].waiting = TRUE, ![c].resolved = FALSE,
                               ![c].rejected = FALSE]
       /\ pc' = [pc EXCEPT ![c] = "waiting"]
       /\ UNCHANGED <<buf, head, trim, recv>>
  /\ UNCHANGED <<produced, complete, err, nextId, pump, joinPos, joinedLate, cancelPhase,
                 cleanupPending>>

\* resumption after `await waitPromise`
Wake(c) ==
  /\ pc[c] = "waiting"
  /\ cons[c].resolved \/ cons[c].rejected
  /\ IF cons[c].rejected
       THEN pc' = [pc EXCEPT ![c] = "errored"]   \* consumer stays in the map
       ELSE pc' = [pc EXCEPT ![c] = "idle"]      \* `return this.next()`
  /\ cons' = [cons EXCEPT ![c].resolved = FALSE, ![c].rejected = FALSE]
  /\ UNCHANGED <<buf, head, trim, produced, complete, err, nextId, pump, recv,
                 joinPos, joinedLate, cancelPhase, cleanupPending>>

\* iterator.return(): consumer-side cancellation
Return(c) ==
  /\ pc[c] \in {"idle", "waiting"}
  /\ Live(c)
  /\ LET cs == [cons EXCEPT ![c].inMap = FALSE, ![c].waiting = FALSE]
         tr == TrimConsumed(buf, head, trim, cs, nextId)
         cl == Cleanup(tr[1], tr[2], cs, complete)
     IN /\ cons' = cs
        /\ buf' = cl[1] /\ head' = cl[2] /\ trim' = tr[3]
  /\ pc' = [pc EXCEPT ![c] = "cancelled"]
  /\ UNCHANGED <<produced, complete, err, nextId, pump, recv, joinPos, joinedLate, cancelPhase,
                 cleanupPending>>

------------------------------------------------------------------------------
(* ReusableReadableStream.cancel(): synchronous part, then an await on the
   source reader's cancel(), then a second dropUnreadBacklog(). *)

CancelSync ==
  /\ AllowStreamCancel
  /\ cancelPhase = "none"
  /\ LET cs == [c \in Consumers |-> [cons[c] EXCEPT !.inMap = FALSE, !.waiting = FALSE]]
         dr == DropUnreadBacklog(buf, head, trim, nextId)
     IN /\ cons' = cs
        /\ buf' = dr[1] /\ head' = dr[2] /\ trim' = dr[3]
  \* every live consumer's pending/next call now returns { done: true }
  /\ pc' = [c \in Consumers |-> IF pc[c] \in {"idle", "waiting"} THEN "cancelled" ELSE pc[c]]
  \* without a source reader (pump never started) there is nothing to await
  /\ cancelPhase' = IF PumpStarted THEN "awaitingSource" ELSE "done"
  /\ UNCHANGED <<produced, complete, err, nextId, pump, recv, joinPos, joinedLate, cleanupPending>>

CancelResume ==
  /\ cancelPhase = "awaitingSource"
  /\ pump = "done"      \* reader.cancel() resolves after the pump observed done
  /\ LET dr == DropUnreadBacklog(buf, head, trim, nextId)
     IN buf' = dr[1] /\ head' = dr[2] /\ trim' = dr[3]
  /\ cancelPhase' = "done"
  /\ UNCHANGED <<produced, complete, err, nextId, pump, cons, pc, recv, joinPos, joinedLate,
                 cleanupPending>>

------------------------------------------------------------------------------
Terminating ==
  /\ (pump = "done" \/ ~PumpStarted)
  /\ \A c \in Consumers : pc[c] \in {"done", "errored", "cancelled", "notStarted"}
  /\ cancelPhase # "awaitingSource"
  /\ ~cleanupPending
  /\ UNCHANGED vars

NextState ==
  \/ Push \/ Complete \/ Fail \/ CleanupMicrotask
  \/ \E c \in Consumers : Create(c) \/ Next(c) \/ Wake(c) \/ Return(c)
  \/ CancelSync \/ CancelResume
  \/ Terminating

Fairness ==
  /\ WF_vars(Complete)
  /\ WF_vars(CancelResume)
  /\ WF_vars(CleanupMicrotask)
  /\ \A c \in Consumers : WF_vars(Next(c)) /\ WF_vars(Wake(c))

Spec == Init /\ [][NextState]_vars /\ Fairness

------------------------------------------------------------------------------
(* Invariants *)

TypeOK ==
  /\ head \in Nat /\ trim \in Nat /\ produced \in Nat
  /\ \A i \in 1..Len(buf) : buf[i] \in 0..MaxValues
  /\ \A c \in Consumers : pc[c] \in PCs

\* produced == trim + (buffered values past head).  The broadcaster's
\* cleanup() clears the buffer without advancing trimOffset, so only the
\* stream variant keeps exact accounting.
BufferAccounting ==
  IF Variant = "stream" THEN produced = trim + Len(buf) - head
                       ELSE produced >= trim + Len(buf) - head

\* A live consumer about to read never hits a negative index or a cleared
\* slot (the code throws "buffer invariant violated" in that case).
NoInvalidRead ==
  \A c \in Consumers :
    (Live(c) /\ pc[c] \in {"idle", "waiting"} /\ HasUnread(c)) =>
      (Idx(c) >= 0 /\ buf[Idx(c) + 1] # CLEARED)

\* A live consumer's position is never behind the trim watermark.
PositionNotBehindTrim ==
  \A c \in Consumers : Live(c) => cons[c].pos >= trim

\* Each consumer receives values in order, contiguous from its join point.
InOrderNoGaps ==
  \A c \in Consumers : \A i \in 1..Len(recv[c]) : recv[c][i] = joinPos[c] + i

\* A consumer that observed completion has seen every value from its join
\* point onward.  Exception (documented trade-off): the broadcaster's
\* cleanup() drops the backlog on completion in active-consumers mode, so a
\* consumer created after completion may see nothing.
CompleteMeansAll ==
  \A c \in Consumers :
    (pc[c] = "done" /\ cancelPhase = "none"
     /\ ~(Variant = "broadcaster" /\ Mode = "active" /\ joinedLate[c])) =>
      joinPos[c] + Len(recv[c]) = produced

\* No consumer wait is lost: a waiting consumer with something to observe
\* has been (or will be, in the same step) resolved.
NoLostWakeup ==
  \A c \in Consumers :
    (Live(c) /\ pc[c] = "waiting" /\ cons[c].waiting) =>
      ~(HasUnread(c) \/ complete \/ err)

Safety == TypeOK /\ BufferAccounting /\ NoInvalidRead /\ PositionNotBehindTrim
          /\ InOrderNoGaps /\ CompleteMeansAll /\ NoLostWakeup

------------------------------------------------------------------------------
(* Liveness *)

\* Every consumer that starts eventually stops waiting once the pump is done.
EventuallyDone ==
  \A c \in Consumers : []((pc[c] # "notStarted") => <>(pc[c] \in {"done", "errored", "cancelled"}))

==============================================================================
