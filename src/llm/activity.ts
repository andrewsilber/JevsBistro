import type { DecisionContext } from "../sim/types";
import type { PlanResponse } from "./protocol";

export interface LlmInteraction {
  provider?: "openai" | "jev";
  id: string;
  scope: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  status: "waiting" | "cooldown" | "received" | "error" | "cancelled";
  attempt?: number;
  retryAt?: number;
  retries?: { at: number; error: string; diagnostics?: unknown }[];
  context: DecisionContext;
  response?: PlanResponse;
  error?: string;
  diagnostics?: unknown;
}
export type ActivitySink = (interaction: LlmInteraction) => void;
/** Retain a bounded, session-only log. No credentials are accepted by this interface. */
export class LlmActivity {
  entries: LlmInteraction[] = [];
  dropped = 0;
  revision = 0;
  receive = (entry: LlmInteraction) => {
    const index = this.entries.findIndex((e) => e.id === entry.id);
    if (index >= 0) this.entries[index] = structuredClone(entry);
    else this.entries.push(structuredClone(entry));
    if (this.entries.length > 200) { this.entries.shift(); this.dropped++; }
    this.revision++;
  };
  cancelScope(scope: string) {
    for (const entry of [...this.entries]) if ((entry.scope === scope || entry.scope.startsWith(`${scope} /`)) && ["waiting", "cooldown"].includes(entry.status))
      this.receive({ ...entry, status: "cancelled", endedAt: Date.now(), error: "Comparison stopped. An in-flight request may still be billed." });
  }
}
