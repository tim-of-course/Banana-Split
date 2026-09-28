import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DurableState } from "./model.js";

export class Store {
  readonly paths: [string, string];
  private generation = 0;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.paths = [join(directory, "state-a.json"), join(directory, "state-b.json")];
  }
  load(): DurableState {
    const valid: Array<{ generation: number; state: DurableState }> = [];
    for (const path of this.paths) {
      if (!existsSync(path)) continue;
      try {
        const checkpoint = JSON.parse(readFileSync(path, "utf8")) as { generation: number; state: DurableState };
        if (Number.isInteger(checkpoint.generation) && checkpoint.state.version === 1) valid.push(checkpoint);
      } catch { /* The other slot remains recoverable after a torn write. */ }
    }
    if (!valid.length) return { version: 1, runnable: [], next_runnable_sequence: 1, next_host_request_sequence: 1, workflows: {} };
    const checkpoint = valid.sort((a, b) => b.generation - a.generation)[0]!;
    this.generation = checkpoint.generation;
    const state = checkpoint.state;
    if (state.version !== 1) throw new Error("Unsupported durable state version");
    if (state.next_host_request_sequence === undefined) {
      state.next_host_request_sequence = 1;
      // Preserve the old queue order once; new requests use commit order, not wall time.
      const pending = Object.values(state.workflows).flatMap(workflow => Object.values(workflow.host_requests))
        .filter(request => request.status === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const request of pending) request.pending_sequence = state.next_host_request_sequence++;
    }
    return state;
  }
  save(state: DurableState): void {
    const generation = ++this.generation;
    const target = this.paths[generation % 2];
    writeFileSync(target, JSON.stringify({ generation, state }, null, 2), { encoding: "utf8", flush: true });
  }
}
