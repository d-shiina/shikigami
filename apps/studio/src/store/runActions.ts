// Store actions for running: whole runs, single steps, debugging, and the
// run events that update the chart and the log.
import { loadBandSettings } from "../lib/bandSettings";
import { valuesBefore } from "../lib/startAt";
import { missingInputs } from "../lib/runInputs";
import type { LogLevel } from "@spellsheet/schema";
import { ApiError } from "../lib/api";
import { errorLine } from "../lib/errorText";
import { emptyTrace, enclosing, findNode, traceEvent, withError } from "../lib/runTrace";
import { t } from "../lib/i18n";
import { ancestorsOf } from "../flow/layout";
import { message, type StoreContext } from "./context";
import { pendingReview } from "./history";
import type { StudioState } from "./index";
import { saveFolded, saveBreakpoints } from "./persist";
import {
  type LogEntry,
  errorPlace,
  asVariableChange,
  STEP_TEST_RUN,
  type RunState,
  loopKey,
  clockKey,
  callPathOf,
  callKey,
  diveChain,
  runBreakpoints,
  isActive,
  newRun,
} from "./run";
import { secretFixOf } from "./secrets";
import { findStep } from "./steps";

export const runActions = ({ api, set, get }: StoreContext) =>
  ({
    async testStep(stepId, values) {
      const flow = get().flow;
      if (!flow || get().stepTest?.running || (get().run && isActive(get().run))) return;
      set({ stepTest: { flowId: flow.id, stepId, running: true, result: null, error: null } });
      try {
        const result = await api.testStep(flow.id, stepId, values);
        set({ stepTest: { flowId: flow.id, stepId, running: false, result, error: null } });
        // Kept under the node's result name, so the node after it can be run alone next.
        const saveAs = findStep(flow.steps ?? [], stepId)?.saveAs;
        if (saveAs && result.status === "succeeded" && result.output !== undefined) {
          set((s) => ({ tested: { ...s.tested, [flow.id]: { ...(s.tested[flow.id] ?? {}), [saveAs]: result.output } } }));
        }
      } catch (e) {
        set({ stepTest: { flowId: flow.id, stepId, running: false, result: null, error: message(e) } });
      }
    },

    async stopStepTest() {
      if (!get().stepTest?.running) return;
      try {
        await api.stopRun(STEP_TEST_RUN);
      } catch {
        // It already ended: its result is on its way.
      }
    },

    async runTo(stepId) {
      if (get().run && isActive(get().run)) return;
      set({ trying: stepId });
      await get().startRun({ stopAt: stepId });
      if (!get().run && !get().askInputs) set({ trying: null });
    },

    async runFrom(stepId) {
      const { run, flow } = get();
      if (!flow || (run && isActive(run))) return;
      await get().startRun({ startAt: stepId, startValues: valuesBefore(run, flow.id, stepId) });
    },

    async startRun(options) {
      const flow = get().flow;
      if (!flow) return;
      if (!options?.inputs && missingInputs(flow, options?.startAt ? options.startValues : undefined).length > 0) {
        set({ askInputs: { flowId: flow.id, options: options ?? {} } });
        return;
      }
      set({ askInputs: null });
      try {
        const breakpoints = [...new Set([...runBreakpoints(get()), ...(options?.stopAt ? [options.stopAt] : [])])];
        // From the runs before this one (a run counts once it has ended).
        if (get().stepTimes?.flowId !== flow.id) set({ stepTimes: null });
        void Promise.resolve()
          .then(() => api.stepTimes(flow.id))
          .then(
            (times) => set({ stepTimes: { flowId: flow.id, times } }),
            () => undefined,
          );
        const runId = await api.run(flow.id, options?.inputs, {
          breakpoints,
          step: options?.step ?? false,
          band: loadBandSettings(),
          ...(options?.startAt ? { startAt: options.startAt, startValues: options.startValues ?? {} } : {}),
        });
        // Not a run up to, from or step by step through a node: its end shows the 実行結果.
        const whole = !options?.step && !options?.stopAt && !options?.startAt;
        set((s) => ({
          // Events may have arrived before the command returned.
          run: { ...(s.run?.runId === runId ? s.run : newRun(runId, flow.id)), whole },
          // A new run's result replaces what a node run alone gave.
          stepTest: null,
          // Values tested alone before this run are older than what it reads.
          tested: { ...s.tested, [flow.id]: {} },
          error: null,
          followRun: true,
          // A run's log opens under the chart.
          bottom: "log",
        }));
      } catch (e) {
        set({ error: message(e) });
      }
    },

    async answerInputs(inputs) {
      const ask = get().askInputs;
      if (!ask || get().flow?.id !== ask.flowId) return set({ askInputs: null, trying: null });
      await get().startRun({ ...ask.options, inputs });
    },

    cancelInputs() {
      set({ askInputs: null, trying: null });
    },
    async stopRun() {
      const run = get().run;
      if (!run) return;
      set((s) => (s.run?.runId === run.runId && isActive(s.run) ? { run: { ...s.run, stopping: true } } : s));
      try {
        await api.stopRun(run.runId);
      } catch (e) {
        if (e instanceof ApiError && e.code === "RUN_NOT_FOUND") {
          // It already ended but its last event never came: do not leave
          // the chart saying it runs, with a stop button that does nothing.
          set((s) =>
            s.run?.runId === run.runId && isActive(s.run)
              ? { run: { ...s.run, status: "cancelled", pause: null, stopping: false }, human: null }
              : s,
          );
          return;
        }
        set({ error: message(e) });
      }
    },

    async debug(command) {
      const run = get().run;
      if (!run || !isActive(run)) return false;
      // Resuming runs the stored revision: never with AI edits nobody has looked at.
      const resumes = !["pause", "setBreakpoints", "setVariable", "abort"].includes(command.action);
      if (resumes && run.pause && get().flow?.revision !== run.pause.revision && pendingReview(get()).length > 0) {
        set({ error: t.runMsg.reviewBeforeResume });
        return false;
      }
      try {
        const outcome = await api.debugRun(run.runId, command);
        if (outcome.updated) set({ notice: t.runMsg.continuingAt(outcome.revision) });
        return true;
      } catch (e) {
        set({
          error:
            e instanceof ApiError && e.code === "RESUME_INCOMPATIBLE"
              ? t.runMsg.pausedStepGone
              : e instanceof ApiError && e.code === "VARIABLE_NOT_EDITABLE"
                ? t.pause.notEditable
                : message(e),
        });
        return false;
      }
    },

    toggleFold(stepId, flowId) {
      const id = flowId ?? get().flow?.id;
      if (!id) return;
      const current = get().folded[id] ?? [];
      const next = current.includes(stepId) ? current.filter((s) => s !== stepId) : [...current, stepId];
      const folded = { ...get().folded, [id]: next };
      if (next.length === 0) delete folded[id];
      saveFolded(folded);
      set({ folded });
    },

    unfoldTo(stepId, inFlow) {
      const flow = inFlow ?? get().flow;
      const current = flow ? get().folded[flow.id] : undefined;
      if (!flow || !current) return;
      const around = new Set(ancestorsOf(flow.steps ?? [], stepId));
      const next = current.filter((id) => !around.has(id));
      if (next.length === current.length) return;
      const folded = { ...get().folded, [flow.id]: next };
      if (next.length === 0) delete folded[flow.id];
      saveFolded(folded);
      set({ folded });
    },

    toggleBreakpoint(stepId, flowId) {
      const id = flowId ?? get().flow?.id;
      if (!id) return;
      const current = get().breakpoints[id] ?? [];
      const next = current.includes(stepId) ? current.filter((s) => s !== stepId) : [...current, stepId];
      const breakpoints = { ...get().breakpoints, [id]: next };
      if (next.length === 0) delete breakpoints[id];
      saveBreakpoints(breakpoints);
      set({ breakpoints });
      const run = get().run;
      if (run && isActive(run) && run.flowId === get().flow?.id) {
        void api.debugRun(run.runId, { action: "setBreakpoints", stepIds: runBreakpoints(get()) }).catch(() => {});
      }
    },

    clearBreakpoints() {
      const flow = get().flow;
      if (!flow) return;
      const breakpoints = { ...get().breakpoints };
      delete breakpoints[flow.id];
      for (const id of Object.keys(get().called)) delete breakpoints[id];
      saveBreakpoints(breakpoints);
      set({ breakpoints });
      const run = get().run;
      if (run && isActive(run) && run.flowId === flow.id) {
        void api.debugRun(run.runId, { action: "setBreakpoints", stepIds: [] }).catch(() => {});
      }
    },

    onRunEvidence(evidence) {
      set((s) =>
        s.run && s.run.runId === evidence.runId && s.run.pause?.seq === evidence.seq ? { run: { ...s.run, evidence } } : s,
      );
    },

    dismissFailure() {
      set((s) => (s.run ? { run: { ...s.run, failure: null } } : s));
    },

    onRunEvent(env) {
      set((s) => {
        let human = s.human;
        let secretFix = s.secretFix;
        let reveal = s.reveal;
        const run: RunState =
          s.run && s.run.runId === env.runId ? { ...s.run, steps: { ...s.run.steps }, logs: s.run.logs } : newRun(env.runId);
        const path = callPathOf(env);
        run.trace = traceEvent(run.trace ?? emptyTrace(), env, (stepId, callPath) => {
          // Only the open flow's run is laid out on its flows.
          if (run.flowId && run.flowId !== s.flow?.id) return undefined;
          const chain = diveChain(s.flow, s.called, callPath);
          const owner = callPath.length === 0 ? s.flow : chain.length === callPath.length ? chain.at(-1)!.flow : null;
          const inside = owner ? enclosing(owner.steps ?? [], stepId) : undefined;
          if (inside === undefined) return undefined;
          if (inside !== null) return { stepId: inside, callPath };
          // At the top of a called flow: inside the call.
          return callPath.length > 0 ? { stepId: callPath.at(-1)!, callPath: callPath.slice(0, -1) } : null;
        });
        const push = (level: LogLevel, msg: string, stepId?: string | null, callPath?: string[], extra: Partial<LogEntry> = {}) => {
          // The node run it is about; a line of the run itself sits in the node running now.
          const node = stepId ? findNode(run.trace, stepId, callPath ?? [])?.key : run.trace.open.at(-1);
          run.logs = [...run.logs, { seq: env.seq, at: env.at, level, message: msg, stepId, ...(callPath?.length ? { callPath } : {}), node: node ?? null, ...extra }];
        };
        if (env.type === "stepFinished" && env.error) {
          const owner = path.length > 0 ? (diveChain(s.flow, s.called, path).at(-1)?.flow ?? null) : s.flow;
          run.trace = withError(run.trace, env.stepId, path, errorLine(env.error, findStep(owner?.steps ?? [], env.stepId)));
        }
        // Followed, the chart goes where the run is: into a called flow
        // when a step starts inside it, back out when one starts outside.
        let dive = s.dive;
        if (env.type === "stepStarted" && s.followRun && callKey(path) !== callKey(s.dive)) {
          if (path.length === 0) dive = [];
          else if (diveChain(s.flow, s.called, path).length === path.length) dive = path;
        }
        // A pause shows where it stopped, followed or not: inside a call, or
        // back in the open flow (a breakpoint after a call, a call that failed).
        if (env.type === "paused" && callKey(path) !== callKey(s.dive)) {
          if (path.length === 0) dive = [];
          else if (diveChain(s.flow, s.called, path).length === path.length) dive = path;
        }
        const moved = dive !== s.dive ? { dive, selection: null } : {};
        // How far each loop got, in the open flow or a called one.
        // A loop starting again (another pass of a loop around it, a retry) starts with nothing to show.
        if (env.type === "stepStarted" && run.loops[loopKey(path, env.stepId)]) {
          const { [loopKey(path, env.stepId)]: _, ...rest } = run.loops;
          run.loops = rest;
        }
        if (env.type === "loopRound" || env.type === "loopEnded") {
          const ended = env.type === "loopEnded";
          run.loops = {
            ...run.loops,
            [loopKey(path, env.stepId)]: {
              round: ended ? env.rounds : env.round,
              total: env.total ?? null,
              ended,
              leftEarly: ended && env.leftEarly === true,
            },
          };
          return { run, ...moved };
        }
        // A value changed while paused (by the person) shows at the pause.
        const edited = asVariableChange(env);
        if (edited && run.pause && edited.iteration == null && callKey(path) === callKey(run.pause.callPath)) {
          run.pause = { ...run.pause, variables: { ...run.pause.variables, [edited.variable]: edited.value } };
        }
        if (env.type === "paused") run.pausedAt = Date.parse(env.at) || Date.now();
        if (env.type === "resumed" && run.pausedAt !== null) {
          const paused = Math.max(0, (Date.parse(env.at) || Date.now()) - run.pausedAt);
          run.clocks = Object.fromEntries(Object.entries(run.clocks).map(([key, clock]) => [key, { ...clock, since: clock.since + paused }]));
          run.pausedAt = null;
        }
        if (env.type === "stepStarted") {
          const since = Date.parse(env.at);
          run.clocks = {
            ...run.clocks,
            [clockKey(path, env.stepId)]: { since: Number.isNaN(since) ? Date.now() : since, waitMs: env.waitMs ?? null, limitMs: env.limitMs ?? null },
          };
        }
        if (path.length > 0 && env.type !== "paused" && env.type !== "resumed") {
          // Inside a called flow: its steps and variables are not the
          // chart's. They show when their call is unfolded or entered.
          const call = path[0]!;
          const key = callKey(path);
          const states = { ...(run.inner[key] ?? {}) };
          if (env.type === "stepStarted") {
            states[env.stepId] = "running";
            run.innerLatest = { ...run.innerLatest, [key]: env.stepId };
          }
          if (env.type === "stepFinished") {
            states[env.stepId] = env.outcome;
            // A failure reaches the call step itself and is logged there.
            if (human?.stepId === call) human = null;
          }
          // The line points at the node in there, not just at the call.
          if (env.type === "log") push(env.level, env.message, env.stepId ?? call, env.stepId ? path : undefined);
          if (env.type === "humanActionRequired") {
            human = { stepId: call, message: env.message, dialog: env.dialog === true };
            push("warn", `${t.waitingForYou}: ${env.message}`, env.stepId, path);
          }
          run.inner = { ...run.inner, [key]: states };
          return { run, human, secretFix, ...moved };
        }
        const change = asVariableChange(env);
        if (change) run.changes = [...run.changes, change];
        switch (env.type) {
          case "runStarted":
            secretFix = null;
            run.status = "running";
            run.flowId = env.flowId;
            run.revision = env.revision;
            push("info", `${env.flowName}${t.runMsg.atRevision(env.revision)}`, null, undefined, { mark: "start", node: null });
            break;
          case "stepStarted":
            run.steps[env.stepId] = "running";
            if ((env.attempt ?? 1) <= 1) run.starts = [...run.starts, { stepId: env.stepId, seq: env.seq }];
            break;
          case "humanActionRequired":
            human = { stepId: env.stepId, message: env.message, dialog: env.dialog === true };
            push("warn", `${t.waitingForYou}: ${env.message}`, env.stepId);
            break;
          case "stepFinished":
            if (human?.stepId === env.stepId) human = null;
            run.steps[env.stepId] = env.outcome;
            if (env.error) {
              // A call that failed inside: the line leads to the node in there.
              const at = errorPlace(s.flow, s.called, env.stepId, env.error.details);
              const owner = at.path.length > 0 ? (diveChain(s.flow, s.called, at.path).at(-1)?.flow ?? null) : s.flow;
              push("error", `${errorLine(env.error, findStep(owner?.steps ?? [], at.stepId))}${env.willRetry ? t.runMsg.willRetry : ""}`, at.stepId, at.path, {
                fromStep: true,
              });
              secretFix = secretFixOf(env.error) ?? secretFix;
            }
            break;
          case "log":
            push(env.level, env.message, env.stepId);
            break;
          case "paused": {
            // Inside a call, the step's state lives with the call's (see `inner`).
            const states = path.length > 0 ? { ...(run.inner[callKey(path)] ?? {}) } : run.steps;
            run.status = "paused";
            run.pause = {
              callPath: path,
              seq: env.seq,
              stepId: env.stepId,
              stepType: env.stepType,
              reason: env.reason,
              error: env.error ?? null,
              variables: env.variables,
              revision: env.revision,
            };
            run.evidence = null;
            states[env.stepId] = env.reason === "error" ? "failed" : "paused";
            if (path.length > 0) run.inner = { ...run.inner, [callKey(path)]: states };
            push(env.reason === "error" ? "error" : "info", env.reason === "error" ? t.runMsg.pausedOnError : t.runMsg.paused, env.stepId, path, {
              mark: "pause",
              node: run.trace.open.at(-1) ?? null,
            });
            if (path.length === 0) reveal = { stepId: env.stepId, seq: (reveal?.seq ?? 0) + 1 };
            break;
          }
          case "resumed": {
            const pause = run.pause;
            run.status = "running";
            run.pause = null;
            run.evidence = null;
            if (pause && pause.callPath.length > 0) {
              const key = callKey(pause.callPath);
              const states = { ...(run.inner[key] ?? {}) };
              if (states[pause.stepId] === "paused") delete states[pause.stepId];
              run.inner = { ...run.inner, [key]: states };
            } else if (pause && run.steps[pause.stepId] === "paused") delete run.steps[pause.stepId];
            if (env.revision != null && pause?.callPath.length === 0) run.revision = env.revision;
            push("info", `${(t.runMsg.resume as Record<string, string>)[env.action] ?? env.action}${env.revision != null ? t.runMsg.atRevision(env.revision) : ""}`, null, undefined, {
              mark: "resume",
              node: run.trace.open.at(-1) ?? null,
            });
            break;
          }
          case "runFinished":
            human = null;
            run.stopping = false;
            run.status = env.status;
            run.pause = null;
            run.failure = env.status === "failed" ? (env.error ?? null) : null;
            push(env.status === "succeeded" ? "info" : "error", `${t.status[env.status]}${t.runMsg.took(env.durationMs)}`, null, undefined, { mark: "end", node: null });
            break;
        }
        return { run, human, secretFix, reveal, ...moved };
      });
      // Where a run pauses is shown, even inside a folded frame.
      const reveal = get().reveal;
      if (env.type === "paused" && reveal?.stepId === env.stepId) get().unfoldTo(env.stepId);
      // 「ここまで実行」: the pause before the node is only a way to get there; run it and pause after.
      const trying = get().trying;
      if (trying && env.type === "paused" && env.stepId === trying && env.reason === "breakpoint") {
        set({ trying: null });
        void get().debug({ action: "stepOver" });
      } else if (trying && env.type === "runFinished") set({ trying: null });
      const ended = get().run;
      if (env.type === "runFinished" && env.status === "succeeded" && ended?.runId === env.runId && ended.whole && ended.flowId) {
        set({ resultFor: { flowId: ended.flowId, runId: env.runId, seq: env.seq } });
      }
    },

    hideTrail() {
      set((s) => (s.run ? { run: { ...s.run, trailHidden: true } } : s));
    },

    clearLog() {
      set((s) => (s.run ? { run: { ...s.run, logs: [], trace: emptyTrace() } } : s));
    },

    dismiss() {
      set({ notice: null, error: null });
    },
  }) satisfies Partial<StudioState>;
