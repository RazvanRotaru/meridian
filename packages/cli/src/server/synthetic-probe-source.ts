/** JavaScript injected into the permission-gated child. Kept dependency-free and reviewable. */

export const SYNTHETIC_PROBE_SOURCE = String.raw`
class SyntheticWatchStop {
  constructor(hitId) { this.hitId = hitId; }
}

class Probe {
  constructor(config, stopHandler) {
    this.config = config;
    this.stopHandler = stopHandler;
    this.storage = new AsyncLocalStorage();
    this.spans = [];
    this.snapshots = [];
    this.active = new Set();
    this.warningSet = new Set(config.warnings);
    this.armed = false;
    this.rootStarted = false;
    this.droppedValues = 0;
    this.droppedEvents = 0;
    this.emittedEvents = 0;
    this.eventSequence = 0;
    this.loopCounts = new Map();
    this.childCounts = new Map();
    this.siteKeys = new Map();
    this.nodeKeys = new Map(Object.keys(config.nodeNames).map((nodeId, index) => [nodeId, index.toString(36)]));
    this.inputOverrideResults = config.inputOverrides.map((override) => ({
      id: override.id,
      target: override.target,
      status: "not-reached",
    }));
    this.watchState = new Map();
    this.watchHits = [];
    this.watchSequence = 0;
    this.stopHitId = undefined;
    this.halted = false;
    this.sequence = 0;
    this.traceId = randomBytes(16).toString("hex");
    this.executionInput = this.cloneJson(config.input);
    this.epochNano = BigInt(Date.now()) * 1000000n;
    this.monotonicStart = process.hrtime.bigint();
  }

  run(nodeId, input, rebindInput, thunk) {
    if (!this.armed) return thunk();
    if (this.halted) throw new SyntheticWatchStop(this.stopHitId);
    const parent = this.storage.getStore();
    if (parent === undefined && (nodeId !== this.config.scenario.rootId || this.rootStarted)) return thunk();
    if (parent === undefined) this.rootStarted = true;
    const occurrenceKey = this.nextOccurrenceKey(nodeId, parent);
    const applied = this.applyInputOverride(nodeId, occurrenceKey, input, rebindInput);
    if (parent === undefined) this.executionInput = this.invocationInput(applied.input);
    const span = this.startSpan(
      nodeId,
      parent?.spanId,
      occurrenceKey,
      applied.input,
      applied.originalInput,
      applied.inputOverrideId,
    );
    this.evaluateWatchers(span, "input", applied.input);
    return this.storage.run({ spanId: span.spanId, occurrenceKey }, () => {
      let value;
      try { value = thunk(); }
      catch (error) { this.rethrowIfControl(error); this.failSpan(span, error); throw error; }
      if (value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function") {
        return Promise.resolve(value).then(
          (output) => { this.finishSpan(span, output); return output; },
          (error) => { this.rethrowIfControl(error); this.failSpan(span, error); throw error; },
        );
      }
      this.finishSpan(span, value);
      return value;
    });
  }

  arm() {
    this.armed = true;
  }

  call(siteId, thunk) {
    if (!this.armed) return thunk();
    if (this.halted) throw new SyntheticWatchStop(this.stopHitId);
    const parent = this.storage.getStore();
    if (parent === undefined) return thunk();
    return this.storage.run({ ...parent, callSiteId: siteId }, thunk);
  }

  rethrowIfControl(error) {
    if (error instanceof SyntheticWatchStop) throw error;
  }

  isControl(error) {
    return error instanceof SyntheticWatchStop;
  }

  branch(siteId, condition, source, outcome) {
    const span = this.currentSpan();
    if (span) {
      const taken = Boolean(outcome);
      this.emitEvent(span, {
        type: "branch.taken",
        eventId: this.nextEventId("branch", span),
        timeUnixNano: this.nowNano(),
        attributes: {},
        siteId,
        pathId: taken ? "then" : "else",
        condition,
        outcome: taken,
        source,
      });
    }
    return outcome;
  }

  loop(siteId, label, source) {
    const span = this.currentSpan();
    if (!span) return;
    let counts = this.loopCounts.get(span.spanId);
    if (!counts) {
      counts = new Map();
      this.loopCounts.set(span.spanId, counts);
    }
    const current = counts.get(siteId);
    if (current) {
      current.iterations = Math.min(Number.MAX_SAFE_INTEGER, current.iterations + 1);
    } else {
      counts.set(siteId, { siteId, label, source, iterations: 1 });
    }
  }

  startSpan(nodeId, parentSpanId, occurrenceKey, input, originalInput, inputOverrideId) {
    const spanId = (++this.sequence).toString(16).padStart(16, "0");
    const startedAtUnixNano = this.nowNano();
    const span = {
      spanId,
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      nodeId,
      name: this.config.nodeNames[nodeId] || nodeId,
      kind: "internal",
      startedAtUnixNano,
      endedAtUnixNano: startedAtUnixNano,
      status: "unset",
      attributes: { "meridian.synthetic": true },
      events: [],
    };
    this.spans.push(span);
    this.active.add(spanId);
    this.snapshots.push({
      spanId,
      nodeId,
      occurrenceKey,
      input: this.snapshot(input),
      ...(originalInput === undefined ? {} : { originalInput: this.snapshot(originalInput), inputOverrideId }),
    });
    return span;
  }

  finishSpan(span, output) {
    if (!this.active.has(span.spanId)) return;
    span.endedAtUnixNano = this.nowNano();
    if (output !== undefined) this.snapshotFor(span).output = this.snapshot(output);
    this.evaluateWatchers(span, "output", output);
    this.active.delete(span.spanId);
    this.flushLoops(span);
    span.status = "ok";
  }

  failSpan(span, error) {
    if (!this.active.delete(span.spanId)) return;
    span.endedAtUnixNano = this.nowNano();
    this.flushLoops(span);
    span.status = "error";
    const message = this.errorMessage(error);
    this.snapshotFor(span).error = message;
    this.emitEvent(span, {
      type: "exception",
      eventId: this.nextEventId("exception", span),
      timeUnixNano: span.endedAtUnixNano,
      attributes: {},
      exceptionType: this.errorName(error),
      message,
      handled: false,
    });
  }

  finish(input, output, invocationError) {
    return this.result(input, output, invocationError, false);
  }

  finishStopped(input) {
    const stoppedAt = this.nowNano();
    const unfinished = this.active.size;
    for (const span of this.spans) {
      if (!this.active.has(span.spanId)) continue;
      span.endedAtUnixNano = stoppedAt;
      this.flushLoops(span);
      span.status = "unset";
    }
    this.active.clear();
    return this.result(input, undefined, undefined, true, unfinished);
  }

  result(input, output, invocationError, stopped, unfinished = this.active.size) {
    const root = this.spans.find((span) => span.parentSpanId === undefined && span.nodeId === this.config.scenario.rootId);
    if (!root) throw new Error("configured root was not observed");
    const starts = this.spans.map((span) => BigInt(span.startedAtUnixNano));
    const ends = this.spans.map((span) => BigInt(span.endedAtUnixNano));
    const traceStart = starts.reduce((best, value) => value < best ? value : best, starts[0]);
    const traceEnd = ends.reduce((best, value) => value > best ? value : best, ends[0]);
    const complete = !stopped && this.active.size === 0 && this.droppedValues === 0 && this.droppedEvents === 0;
    return {
      executionVersion: "1.0.0",
      scenarioId: this.config.scenario.id,
      rootId: this.config.scenario.rootId,
      generatedAt: new Date().toISOString(),
      input: this.executionInput,
      outcome: stopped ? "stopped" : "completed",
      ...(!stopped && output !== undefined && invocationError === undefined ? { output: this.snapshot(output) } : {}),
      trace: {
        traceId: this.traceId,
        name: this.config.scenario.label,
        rootSpanId: root.spanId,
        startedAtUnixNano: traceStart.toString(),
        endedAtUnixNano: traceEnd.toString(),
        status: stopped ? "unset" : root.status === "error" ? "error" : "ok",
        attributes: {
          "meridian.synthetic": true,
          "meridian.synthetic.scenario_id": this.config.scenario.id,
        },
        spans: this.spans,
        completeness: {
          complete,
          droppedSpans: 0,
          droppedEvents: this.droppedEvents,
          droppedValues: unfinished + this.droppedValues,
        },
      },
      snapshots: this.snapshots,
      inputOverrideResults: this.inputOverrideResults,
      watchHits: this.watchHits,
      ...(stopped ? { stop: { reason: "watcher", watchHitId: this.stopHitId } } : {}),
      warnings: [...this.warningSet].slice(0, 256),
    };
  }

  snapshotFor(span) {
    return this.snapshots.find((candidate) => candidate.spanId === span.spanId);
  }

  currentSpan() {
    const context = this.storage.getStore();
    return context === undefined || !this.active.has(context.spanId)
      ? undefined
      : this.spans.find((candidate) => candidate.spanId === context.spanId);
  }

  nextOccurrenceKey(nodeId, parent) {
    if (parent === undefined) return "r";
    const siteKey = parent.callSiteId === undefined ? "unknown" : this.siteKey(parent.callSiteId);
    const counterKey = parent.occurrenceKey + "\u0000" + siteKey + "\u0000" + nodeId;
    const ordinal = (this.childCounts.get(counterKey) || 0) + 1;
    this.childCounts.set(counterKey, ordinal);
    return parent.occurrenceKey + "." + siteKey + ":" + (this.nodeKeys.get(nodeId) || "x") + ":" + ordinal.toString(36);
  }

  siteKey(siteId) {
    const existing = this.siteKeys.get(siteId);
    if (existing !== undefined) return existing;
    const key = createHash("sha256").update(siteId).digest("base64url").slice(0, 12);
    this.siteKeys.set(siteId, key);
    return key;
  }

  applyInputOverride(nodeId, occurrenceKey, input, rebindInput) {
    const override = this.config.inputOverrides.find((candidate) => (
      candidate.target.nodeId === nodeId && candidate.target.occurrenceKey === occurrenceKey
    ));
    if (!override) return { input };
    const result = this.inputOverrideResults.find((candidate) => candidate.id === override.id);
    if (typeof rebindInput !== "function" || !this.isRecord(override.input)) {
      result.status = "unsupported";
      result.message = "This occurrence uses parameters that cannot be rebound safely.";
      return { input };
    }
    const effective = this.cloneJson(override.input);
    rebindInput(effective);
    result.status = "applied";
    return { input: effective, originalInput: input, inputOverrideId: override.id };
  }

  evaluateWatchers(span, phase, boundaryValue) {
    if (this.halted) throw new SyntheticWatchStop(this.stopHitId);
    const snapshot = this.snapshotMaybe(boundaryValue);
    for (const watcher of this.config.watchers) {
      if (watcher.phase !== phase) continue;
      if (watcher.nodeId !== undefined && watcher.nodeId !== span.nodeId) continue;
      const occurrenceKey = this.snapshotFor(span).occurrenceKey;
      if (watcher.occurrenceKey !== undefined && watcher.occurrenceKey !== occurrenceKey) continue;
      const observed = this.readPath(snapshot, watcher.path);
      const previous = this.watchState.get(watcher.id);
      const hit = watcher.operator === "exists"
        ? observed.present
        : watcher.operator === "equals"
          ? observed.present && this.jsonEqual(observed.value, watcher.expected)
          : previous !== undefined && (
            previous.present !== observed.present
            || (observed.present && !this.jsonEqual(previous.value, observed.value))
          );
      this.watchState.set(watcher.id, { present: observed.present, value: observed.value });
      if (!hit) continue;
      const watchHit = {
        id: "watch-hit-" + (++this.watchSequence).toString(36),
        watcherId: watcher.id,
        spanId: span.spanId,
        nodeId: span.nodeId,
        occurrenceKey,
        phase,
        path: watcher.path,
        operator: watcher.operator,
        present: observed.present,
        ...(observed.present ? { value: observed.value } : {}),
        ...(previous === undefined ? {} : {
          previousPresent: previous.present,
          ...(previous.present ? { previousValue: previous.value } : {}),
        }),
        timeUnixNano: this.nowNano(),
      };
      this.watchHits.push(watchHit);
      this.stopHitId = watchHit.id;
      this.halted = true;
      if (typeof this.stopHandler === "function") {
        this.stopHandler(this.finishStopped(this.executionInput));
      }
      throw new SyntheticWatchStop(watchHit.id);
    }
  }

  invocationInput(boundaryInput) {
    if (!this.isRecord(boundaryInput)) return this.cloneJson(this.config.input);
    const keys = Object.keys(boundaryInput);
    return keys.length === 1
      ? this.snapshot(boundaryInput[keys[0]])
      : this.cloneJson(this.config.input);
  }

  snapshotMaybe(value) {
    return value === undefined ? undefined : this.snapshot(value);
  }

  readPath(root, path) {
    let current = root;
    if (current === undefined) return { present: false };
    for (const segment of path) {
      if (current === null || (typeof current !== "object" && !Array.isArray(current))) return { present: false };
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return { present: false };
      current = current[segment];
      if (current === undefined) return { present: false };
    }
    return { present: true, value: current };
  }

  jsonEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(this.snapshotMaybe(right));
  }

  cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  flushLoops(span) {
    const counts = this.loopCounts.get(span.spanId);
    this.loopCounts.delete(span.spanId);
    if (!counts) return;
    for (const loop of counts.values()) {
      this.emitEvent(span, {
        type: "loop.summary",
        eventId: this.nextEventId("loop", span),
        timeUnixNano: span.endedAtUnixNano,
        attributes: {},
        siteId: loop.siteId,
        label: loop.label,
        iterations: loop.iterations,
        emittedIterations: loop.iterations,
        truncated: false,
        source: loop.source,
      });
    }
  }

  nextEventId(kind, span) {
    this.eventSequence += 1;
    return kind + "-" + span.spanId + "-" + this.eventSequence.toString(16);
  }

  emitEvent(span, event) {
    if (this.emittedEvents >= 2000) {
      this.droppedEvents += 1;
      this.warningSet.add("Runtime control events were truncated after 2000 events.");
      return;
    }
    this.emittedEvents += 1;
    span.events.push(event);
  }

  nowNano() {
    return (this.epochNano + process.hrtime.bigint() - this.monotonicStart).toString();
  }

  errorName(error) {
    return typeof error === "object" && error !== null && typeof error.name === "string"
      ? error.name.slice(0, 256)
      : "Error";
  }

  errorMessage(error) {
    const text = typeof error === "object" && error !== null && typeof error.message === "string"
      ? error.message
      : String(error);
    return (this.errorName(error) + ": " + text).slice(0, MAX_STRING);
  }

  snapshot(value) {
    const seen = new WeakSet();
    let nodes = 0;
    const visit = (current, depth) => {
      nodes += 1;
      if (nodes > MAX_NODES) { this.drop("Snapshot truncated after 4096 values."); return "[Truncated]"; }
      if (depth > MAX_DEPTH) { this.drop("Snapshot truncated beyond depth 12."); return "[Max depth]"; }
      if (current === null || typeof current === "boolean") return current;
      if (typeof current === "string") {
        if (current.length > MAX_STRING) this.drop("Snapshot strings were truncated.");
        return current.slice(0, MAX_STRING);
      }
      if (typeof current === "number") { if (!Number.isFinite(current)) this.drop("Non-finite numbers were stringified."); return Number.isFinite(current) ? current : String(current); }
      if (typeof current === "bigint") { this.drop("Bigints were stringified."); return current.toString() + "n"; }
      if (typeof current === "undefined") { this.drop("Undefined values were represented as text."); return "[undefined]"; }
      if (typeof current === "symbol") { this.drop("Symbols were represented as text."); return String(current); }
      if (typeof current === "function") { this.drop("Functions were represented as text."); return "[Function " + (current.name || "anonymous") + "]"; }
      if (seen.has(current)) { this.drop("Circular references were truncated."); return "[Circular]"; }
      seen.add(current);
      if (current instanceof Date) return Number.isFinite(current.getTime()) ? current.toISOString() : "Invalid Date";
      if (Array.isArray(current)) {
        if (current.length > MAX_ITEMS) this.drop("Snapshot arrays were truncated to 512 entries.", current.length - MAX_ITEMS);
        return current.slice(0, MAX_ITEMS).map((entry) => visit(entry, depth + 1));
      }
      const result = {};
      let descriptors;
      try { descriptors = Object.getOwnPropertyDescriptors(current); }
      catch { this.drop("An object could not be inspected."); return "[Uninspectable object]"; }
      const keys = Object.keys(descriptors).sort();
      if (keys.length > MAX_ITEMS) this.drop("Snapshot objects were truncated to 512 properties.", keys.length - MAX_ITEMS);
      for (const key of keys.slice(0, MAX_ITEMS)) {
        const descriptor = descriptors[key];
        if ("value" in descriptor) result[key.slice(0, 1024)] = visit(descriptor.value, depth + 1);
        else { this.drop("Getter values were not invoked."); result[key.slice(0, 1024)] = "[Getter]"; }
      }
      return result;
    };
    return visit(value, 0);
  }

  drop(message, count = 1) {
    this.warningSet.add(message);
    this.droppedValues += Math.max(1, count);
  }
}
`;
