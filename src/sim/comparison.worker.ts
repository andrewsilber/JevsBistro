import { CONDITIONS, PROXY_CONDITIONS, type ComparisonRun } from "./comparison";
import { Simulation } from "./engine";
import { DiagnosticRecorder } from "./diagnostics";
import type { Config } from "./types";
import { requestPlan } from "../llm/client";
import { emptyUsage, type ProxySettings } from "../llm/protocol";
type Start = { config: Config; count: number; proxy: boolean; diagnostic?: boolean; settings: ProxySettings; scope: string };
const worker = self as unknown as { onmessage: (e: MessageEvent<Start | { type: "stop" }>) => void; postMessage: (data: unknown) => void };
let stopped = false;
let abort: AbortController | undefined;
worker.onmessage = async ({ data }) => {
  if ("type" in data && data.type === "stop") { stopped = true; abort?.abort(); return; }
  if (!("config" in data)) return;
  try {
    const conditions = data.proxy ? PROXY_CONDITIONS : CONDITIONS;
    for (let i = 0; i < data.count; i++) for (const condition of conditions) {
      if (stopped) { worker.postMessage({ type: "stopped" }); return; }
      const config = { ...data.config, ...condition, seed: (data.config.seed + i) % 2147483648 };
      const proxy = "proxy" in condition && condition.proxy;
      worker.postMessage({ type: "starting", seed: config.seed, ...condition });
      const recorder = data.diagnostic ? new DiagnosticRecorder() : undefined;
      const sim = new Simulation(config, undefined, undefined, { recordHistory: false, externalDecisions: proxy, observer: recorder });
      const usage = emptyUsage();
      let error: string | undefined, ticks = 0;
      abort = new AbortController();
      try {
        while (!sim.finished && sim.now < config.duration * 60 + 14400 && !stopped) {
          sim.step();
          if (sim.pendingDecision) {
            const pending = sim.pendingDecision;
            worker.postMessage({ type: "planning", at: sim.now, usage });
            const response = await requestPlan(pending.context, data.settings, usage, abort.signal, { scope: `${data.scope} / seed ${config.seed}`, emit: (entry) => {
              recorder?.interaction(entry); worker.postMessage({ type: "interaction", entry });
            } });
            if (stopped) break;
            sim.resolveDecision(pending.id, response.ids);
          } else recorder?.sample(sim);
          if (++ticks % 200 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch (e) { error = (e as Error).message; }
      if (stopped) error = "Stopped by user; unfinished run.";
      const run: ComparisonRun = { seed: config.seed, planner: config.planner, mode: config.mode, proxy, provider: proxy ? data.settings.provider ?? "openai" : undefined, finished: sim.finished, simulatedSeconds: sim.now, metrics: sim.metrics,
        usage: proxy ? usage : undefined, error, diagnostics: recorder?.finish(sim) };
      worker.postMessage({ type: "run", run });
      if (stopped) { worker.postMessage({ type: "stopped" }); return; }
      if (error) { worker.postMessage({ type: "error", message: `AI paused: ${error} Partial results retained; not a completed comparison.` }); return; }
    }
    worker.postMessage({ type: "done" });
  } catch (error) { worker.postMessage({ type: "error", message: String(error) }); }
};
