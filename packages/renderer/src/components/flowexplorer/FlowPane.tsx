import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import type {
  LogicFlows,
  RequestTrace,
  SyntheticExecution,
  SyntheticFieldWatcher,
  SyntheticInputOverride,
} from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { logicNodeTypes } from "../nodes/logic/logicNodeTypes";
import { logicEdgeTypes } from "../edges/AsyncRailEdge";
import { LogicEdgeActionScope } from "../edges/LogicEdgeActionScope";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "../canvas/flowCanvasProps";
import type { LogicNodeData } from "../../derive/logicGraph";
import { stepsAt, type FlowSelectionRef } from "../../derive/flowBlocks";
import { blockBreadcrumbs } from "./flowBlockLabels";
import { ancestorSelection, REVIEW_FLOW_SPLIT_ID, selectionKey } from "./flowSelection";
import { useLogicFlows } from "./useFlowTree";
import { TimelineView } from "../logicviews/TimelineView";
import { METRO_COMPACT_TOP_PADDING, MetroView } from "../logicviews/MetroView";
import { BlocksView } from "../logicviews/BlocksView";
import { FLOW_COLORS, type FlowViewProps } from "../../derive/flowViewModel";
import { BASE_Y as METRO_MAIN_LINE_Y } from "../../derive/metroSpec";
import type { ReviewFlowSplitView } from "../../state/reviewPreferences";
import { BaseNodeActionScope, type BaseNodeModel } from "../nodes/BaseNode";
import { reviewFlowChanges, type ReviewFlowChange } from "../../derive/reviewFlowChanges";
import { changedColor } from "../ChangedBadge";
import { changedTextColor } from "../../theme/changedColors";
import {
  SYNTHETIC_ACTION_BUTTON_STYLE,
  SYNTHETIC_ERROR_STYLE,
  SyntheticAvailabilityNotice,
  SyntheticInputEditor,
} from "../synthetic/SyntheticExecutionControls";
import {
  useSyntheticExecutionController,
  formatSyntheticInputJson,
  type SyntheticExecutionController,
} from "../synthetic/useSyntheticExecutionController";
import { SyntheticFlowNavigator } from "../synthetic/SyntheticFlowNavigator";
import { SyntheticDataInspector } from "../synthetic/SyntheticDataInspector";
import { SyntheticRunInputPanel } from "../synthetic/SyntheticRunInputPanel";
import { SyntheticRunImpactPanel } from "../synthetic/SyntheticRunImpactPanel";
import { SyntheticExperimentSummary } from "../synthetic/SyntheticExperimentPanel";
import {
  adjacentSyntheticOccurrence,
  selectedSyntheticOccurrenceIndex,
  syntheticOccurrenceSteps,
  type SyntheticOccurrenceStep,
} from "../../synthetic/syntheticFlowModel";
import { compareSyntheticExecutions } from "../../synthetic/syntheticExecutionComparison";
import { LogicFlowOrientationProvider } from "../nodes/logic/LogicFlowOrientationContext";
import type { LogicFlowOrientation } from "../../layout/logicElk";
import { deriveObservedRequestRoute } from "../../derive/requestObservedRoute";
import { ObservedRouteStrip } from "./ObservedRouteStrip";
import {
  useNodeDiffPreview,
  type CodePreviewTarget,
} from "../review/useNodeDiffPreview";
import { sequenceTimelineFor } from "../../derive/sequenceTimelineExtension";
import { causalSequenceTimelineFor } from "../../derive/causalSequenceTimeline";
import type { SequenceTimelineModel } from "../../derive/sequenceTimelineModel";

const EMPTY_INPUT_OVERRIDES: readonly SyntheticInputOverride[] = [];
const EMPTY_FIELD_WATCHERS: readonly SyntheticFieldWatcher[] = [];

export {
  preferredSyntheticScenario,
  syntheticScenariosForRoot,
} from "../synthetic/useSyntheticExecutionController";

interface FlowPaneFocusRequest {
  targetId: string;
  sequence: number;
}

export function FlowPane() {
  const selection = useBlueprint((state) => state.flowSelection);
  const origin = useBlueprint((state) => state.flowPaneOrigin);
  const requestFlowTraceId = useBlueprint((state) => state.requestFlowTraceId);
  const index = useBlueprint((state) => state.index);
  const reviewActive = useBlueprint((state) => state.flowSelection !== null && state.reviewFlowBaseline !== null);
  const reviewFlowSplitView = useBlueprint((state) => state.reviewFlowSplitView);
  const reviewOpenFlowSplitOnSelect = useBlueprint((state) => state.reviewOpenFlowSplitOnSelect);
  const reviewFlowExplicitView = useBlueprint((state) => state.reviewFlowExplicitView);
  const flows = useLogicFlows();
  const environment = useBlueprint((state) => state.environment);
  const logicSelected = useBlueprint((state) => state.logicSelected);
  const syntheticExecutionHost = useBlueprint((state) => state.syntheticExecutionHost);
  const synthetic = useSyntheticExecutionController(
    selection?.rootId ?? null,
    syntheticExecutionHost ?? "flow-pane",
  );
  const syntheticExecution = synthetic.execution;
  const syntheticSelectedMomentId = useBlueprint((state) => state.syntheticSelectedMomentId);
  const syntheticFlowOrientation = useBlueprint((state) => state.syntheticFlowOrientation);
  const syntheticFlowPresentation = useBlueprint((state) => state.syntheticFlowPresentation);
  const requestTrace = useBlueprint((state) => origin !== "request" || requestFlowTraceId === null
    ? null
    : state.requestTraces.find((trace) => trace.traceId === requestFlowTraceId) ?? null);
  const { selectFlowEntry, selectFlowPaneTarget, openLogicFlow } = useBlueprintActions();
  const [focusRequest, setFocusRequest] = useState<FlowPaneFocusRequest | null>(null);
  const observedRequestRoute = useMemo(
    () => requestTrace === null ? null : deriveObservedRequestRoute(requestTrace),
    [requestTrace],
  );
  const requestOpen = origin === "request" && requestTrace !== null;
  const syntheticOpen = origin === "synthetic" && syntheticExecution !== null && selection !== null;
  const executionOpen = requestOpen || syntheticOpen;
  const reviewSplitOpen = reviewOpenFlowSplitOnSelect || reviewFlowExplicitView !== null;
  if (!executionOpen && (selection === null || !flowPaneShouldRender(reviewActive, reviewSplitOpen))) {
    return null;
  }
  const rootLabel = requestOpen
    ? "Request execution"
    : syntheticOpen
      ? "Synthetic execution"
      : index.nodesById.get(selection!.rootId)?.displayName ?? selection!.rootId;
  const crumbs = executionOpen ? [] : blockBreadcrumbs(flows, selection!);
  const requestContext = requestOpen ? requestFlowContext(requestTrace, environment) : null;
  const syntheticContext = syntheticOpen ? requestFlowContext(syntheticExecution.trace, null) : null;
  const presentation = executionOpen
    ? "graph"
    : flowPanePresentation(reviewActive, reviewFlowExplicitView ?? reviewFlowSplitView);
  const reviewChanges = reviewActive && selection !== null
    ? reviewFlowChanges(selection.rootId, stepsAt(flows, selection) ?? [], index)
    : [];
  const focusChange = (change: ReviewFlowChange) => {
    selectFlowPaneTarget(change.targetId);
    setFocusRequest((current) => ({ targetId: change.targetId, sequence: (current?.sequence ?? 0) + 1 }));
  };
  const viewKey = requestOpen
    ? `request:${requestTrace!.traceId}`
    : syntheticOpen
      ? `synthetic:${syntheticExecution.trace.traceId}:${syntheticExecution.generatedAt}:${syntheticSelectedMomentId ?? "none"}:${syntheticFlowOrientation}:${syntheticFlowPresentation}`
    : `${presentation}:${selectionKey(selection!)}`;
  const canLaunchSynthetic = !requestOpen
    && !syntheticOpen
    && selection !== null;
  return (
    <aside
      id={reviewActive ? REVIEW_FLOW_SPLIT_ID : undefined}
      style={DRAWER}
      aria-label={reviewActive ? "Logic flow review" : requestOpen ? "Selected request logic flow" : syntheticOpen ? "Synthetic flow execution" : "Code flow"}
    >
      <header style={HEADER}>
        <div style={TITLE_ROW}>
          <span style={GLYPH}>ƒ</span>
          <span style={TITLE} title={requestOpen ? requestTrace!.name : selection!.rootId}>{rootLabel}</span>
          {reviewChanges.length > 0 ? (
            <FlowChangeNavigator changes={reviewChanges} selectedTarget={logicSelected} onFocus={focusChange} />
          ) : null}
          {canLaunchSynthetic ? (
            <button
              type="button"
              style={SYNTHETIC_ACTION_BUTTON_STYLE}
              disabled={synthetic.status === "running"}
              aria-expanded={synthetic.editorOpen}
              onClick={synthetic.toggleEditor}
            >
              {synthetic.buttonLabel}
            </button>
          ) : null}
          {syntheticOpen ? (
            <button type="button" style={OPEN_BUTTON} onClick={synthetic.clear}>Static flow</button>
          ) : requestOpen ? null : (
            <button type="button" style={OPEN_BUTTON} onClick={() => openLogicFlow(selection!.rootId)}>
              Open in Logic flow
            </button>
          )}
          <button type="button" style={CLOSE} title="Close flow pane" onClick={() => selectFlowEntry(null)}>
            ✕
          </button>
        </div>
        {synthetic.editorOpen && canLaunchSynthetic ? (
          synthetic.canGenerate ? (
            <SyntheticInputEditor
              scenario={synthetic.scenario!}
              scenarios={synthetic.scenarios}
              value={synthetic.input}
              status={synthetic.status}
              error={synthetic.inputError ?? synthetic.error}
              executionTrust={synthetic.executionTrust!}
              sandboxConsent={synthetic.sandboxConsent}
              onChange={synthetic.setInput}
              onSandboxConsentChange={synthetic.setSandboxConsent}
              onScenarioChange={synthetic.selectScenario}
              onCancel={synthetic.cancelEditor}
              onRun={synthetic.submit}
            />
          ) : (
            <SyntheticAvailabilityNotice
              message={synthetic.availabilityMessage ?? "Synthetic execution is unavailable for this flow."}
              onClose={synthetic.cancelEditor}
            />
          )
        ) : synthetic.error !== null && !syntheticOpen
          ? <div style={SYNTHETIC_ERROR_STYLE} role="alert">{synthetic.error}</div>
          : null}
        {requestContext ? (
          <>
            <RequestContext context={requestContext} />
            {observedRequestRoute === null ? null : (
              <ObservedRouteStrip
                route={observedRequestRoute}
                labelForNode={(nodeId) => index.nodesById.get(nodeId)?.displayName}
              />
            )}
          </>
        ) : syntheticContext ? (
          <RequestContext
            context={syntheticContext}
            eyebrow={synthetic.executionTrust?.mode === "sandboxed-pr"
              ? "SYNTHETIC · UNTRUSTED PR SANDBOX"
              : "SYNTHETIC · TRUSTED LOCAL RUN"}
            warnings={syntheticExecution!.warnings}
            observedEdgeLabel="observed execution path"
          />
        ) : (
          <nav style={BREADCRUMBS} aria-label="Selected flow block">
            <button type="button" style={CRUMB} onClick={() => selectFlowEntry(ancestorSelection(selection!, 0))}>
              {rootLabel}
            </button>
            {crumbs.map((crumb) => (
              <span key={selectionKey(crumb.ref)} style={CRUMB_GROUP}>
                <span style={CRUMB_SEP}>›</span>
                <button type="button" style={CRUMB} onClick={() => selectFlowEntry(crumb.ref)}>
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
        )}
      </header>
      <div style={BODY}>
        {syntheticOpen ? (
          <SyntheticFlowPlayer execution={syntheticExecution!} controller={synthetic} />
        ) : presentation === "graph" ? (
          <ReactFlowProvider key={viewKey}>
            <FlowPaneSurface focusRequest={focusRequest} />
          </ReactFlowProvider>
        ) : (
          <FlowPaneProjection key={viewKey} mode={presentation} selection={selection!} flows={flows} focusRequest={focusRequest} />
        )}
      </div>
    </aside>
  );
}

export function FlowChangeNavigator(props: {
  changes: readonly ReviewFlowChange[];
  selectedTarget: string | null;
  onFocus: (change: ReviewFlowChange) => void;
}) {
  if (props.changes.length === 0) {
    return null;
  }
  const selectedIndex = props.selectedTarget === null
    ? -1
    : props.changes.findIndex((change) => change.targetId === props.selectedTarget);
  const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const current = props.changes[currentIndex];
  const count = props.changes.length;
  const focusAt = (index: number) => props.onFocus(props.changes[(index + count) % count]);
  const status = current.status.toUpperCase();
  const accent = changedColor(current.status);
  const color = changedTextColor(current.status);
  const position = count === 1 ? "" : ` · ${currentIndex + 1}/${count}`;
  return (
    <div style={CHANGE_NAV} role="group" aria-label="Changed nodes in this logic flow">
      {count > 1 ? (
        <button type="button" style={CHANGE_ARROW} aria-label="Previous changed node" title="Previous changed node" onClick={() => focusAt(currentIndex - 1)}>
          ‹
        </button>
      ) : null}
      <button
        type="button"
        style={{ ...CHANGE_FOCUS, color, borderColor: `${accent}99`, background: `${accent}1F` }}
        aria-label={`Focus ${current.status} node ${current.label}${count > 1 ? `, ${currentIndex + 1} of ${count}` : ""}`}
        title={`Focus ${current.status} node: ${current.label}`}
        onClick={() => focusAt(currentIndex)}
      >
        <span style={CHANGE_GLYPH} aria-hidden="true">Δ</span>
        <span style={CHANGE_STATUS}>{status}{position}</span>
        <span style={CHANGE_NAME}>{current.label}</span>
      </button>
      {count > 1 ? (
        <button type="button" style={CHANGE_ARROW} aria-label="Next changed node" title="Next changed node" onClick={() => focusAt(currentIndex + 1)}>
          ›
        </button>
      ) : null}
    </div>
  );
}

/** The persisted preference affects PR review only; the general Code flows explorer deliberately
 * retains its established execution graph even when the same user prefers another projection. */
export function flowPanePresentation(
  reviewActive: boolean,
  reviewFlowSplitView: ReviewFlowSplitView,
): ReviewFlowSplitView {
  return reviewActive ? reviewFlowSplitView : "graph";
}

/** Hiding the PR split is presentation-only: the selection still drives the upper graph. The
 * ordinary Code-flow explorer ignores this review preference and always keeps its pane. */
export function flowPaneShouldRender(reviewActive: boolean, openFlowSplitOnSelect: boolean): boolean {
  return !reviewActive || openFlowSplitOnSelect;
}

function SyntheticFlowPlayer({
  execution,
  controller,
}: {
  execution: SyntheticExecution;
  controller: SyntheticExecutionController;
}) {
  const index = useBlueprint((state) => state.index);
  const scenarios = useBlueprint((state) => state.syntheticScenarios);
  const previousExecution = useBlueprint((state) => state.syntheticPreviousExecution);
  const experimentRootId = useBlueprint((state) => state.syntheticExperimentRootId);
  // Keep store snapshots referentially stable. Returning a fresh [] from a Zustand selector makes
  // React 19 correctly treat every getSnapshot call as a new state and can cause a render loop.
  const stagedInputOverrides = useBlueprint((state) => state.syntheticInputOverrides);
  const stagedFieldWatchers = useBlueprint((state) => state.syntheticFieldWatchers);
  const inputOverrides = experimentRootId === execution.rootId ? stagedInputOverrides : EMPTY_INPUT_OVERRIDES;
  const fieldWatchers = experimentRootId === execution.rootId ? stagedFieldWatchers : EMPTY_FIELD_WATCHERS;
  const selectedId = useBlueprint((state) => state.syntheticSelectedMomentId);
  const orientation = useBlueprint((state) => state.syntheticFlowOrientation);
  const presentation = useBlueprint((state) => state.syntheticFlowPresentation);
  const {
    selectSyntheticMoment,
    setSyntheticFlowOrientation,
    setSyntheticFlowPresentation,
    stageSyntheticInputOverride,
    removeSyntheticInputOverride,
    addSyntheticFieldWatcher,
    removeSyntheticFieldWatcher,
  } = useBlueprintActions();
  const steps = useMemo(() => syntheticOccurrenceSteps(execution, index), [execution, index]);
  const selectedIndex = selectedSyntheticOccurrenceIndex(steps, selectedId);
  const selected = selectedIndex < 0 ? null : steps[selectedIndex] ?? null;
  const scenario = scenarios.find((candidate) => candidate.id === execution.scenarioId);
  const rootLabel = index.nodesById.get(execution.rootId)?.displayName ?? execution.rootId;
  const comparison = useMemo(
    () => previousExecution === null ? null : compareSyntheticExecutions(previousExecution, execution),
    [execution, previousExecution],
  );
  const visibleComparison = controller.scenario?.id === execution.scenarioId ? comparison : null;
  const selectedOverride = selected?.snapshot === null || selected?.snapshot === undefined
    ? null
    : inputOverrides.find((override) => override.target.nodeId === selected.snapshot!.nodeId
      && override.target.occurrenceKey === selected.snapshot!.occurrenceKey) ?? null;
  const selectedWatchers = selected?.snapshot === null || selected?.snapshot === undefined
    ? []
    : fieldWatchers.filter((watcher) => watcher.nodeId === selected.snapshot!.nodeId
      && (watcher.occurrenceKey === undefined || watcher.occurrenceKey === selected.snapshot!.occurrenceKey));
  const selectedWatchHit = selected === null
    ? null
    : execution.watchHits.find((hit) => hit.spanId === selected.spanId) ?? null;

  const selectStep = (step: SyntheticOccurrenceStep | null) => {
    if (step !== null) selectSyntheticMoment(step.id, step.nodeId);
  };

  return (
    <div style={SYNTHETIC_PLAYER} data-synthetic-flow-player>
      {controller.scenario === null ? null : (
        <div style={syntheticExperimentRowStyle(visibleComparison !== null)}>
          <SyntheticRunInputPanel
            rootLabel={rootLabel}
            scenario={controller.scenario}
            scenarios={controller.scenarios}
            value={controller.input}
            currentInput={execution.input}
            status={controller.status}
            error={controller.inputError ?? controller.error}
            executionTrust={controller.executionTrust!}
            sandboxConsent={controller.sandboxConsent}
            onChange={controller.setInput}
            onSandboxConsentChange={controller.setSandboxConsent}
            onScenarioChange={controller.selectScenario}
            onReset={() => controller.setInput(formatSyntheticInputJson(execution.input))}
            onRun={controller.submit}
          />
          {visibleComparison === null ? null : (
            <SyntheticRunImpactPanel
              comparison={visibleComparison}
              selectedCurrentSpanId={selected?.spanId ?? null}
              labelForNode={(nodeId) => index.nodesById.get(nodeId)?.displayName}
              onSelectCurrentOccurrence={(spanId) => {
                selectStep(steps.find((step) => step.spanId === spanId) ?? null);
              }}
            />
          )}
        </div>
      )}
      {experimentRootId !== execution.rootId ? null : (
        <SyntheticExperimentSummary
          overrides={inputOverrides}
          watchers={fieldWatchers}
          execution={execution}
          onRemoveOverride={removeSyntheticInputOverride}
          onRemoveWatcher={removeSyntheticFieldWatcher}
        />
      )}
      <SyntheticFlowNavigator
        steps={steps}
        selectedId={selected?.id ?? null}
        scenarioLabel={scenario?.label ?? execution.scenarioId}
        rootLabel={rootLabel}
        onSelect={(id) => selectStep(steps.find((step) => step.id === id) ?? null)}
        onPrevious={() => selectStep(adjacentSyntheticOccurrence(steps, selected?.id ?? null, -1))}
        onNext={() => selectStep(adjacentSyntheticOccurrence(steps, selected?.id ?? null, 1))}
      />
      <div style={SYNTHETIC_PLAYER_CONTENT}>
        <section
          style={SYNTHETIC_CANVAS_COLUMN}
          aria-label={selected === null ? "Focused synthetic logic flow" : `Focused synthetic logic flow for ${selected.label}`}
          data-synthetic-flow-orientation={orientation}
          data-synthetic-flow-presentation={presentation}
        >
          <SyntheticFlowToolbar
            selected={selected}
            orientation={orientation}
            presentation={presentation}
            onOrientationChange={setSyntheticFlowOrientation}
            onPresentationChange={setSyntheticFlowPresentation}
          />
          <div style={SYNTHETIC_CANVAS}>
            <LogicFlowOrientationProvider value={presentation === "overview" ? "horizontal" : orientation}>
              <ReactFlowProvider key={`${execution.trace.traceId}:${selected?.id ?? "none"}:${orientation}:${presentation}`}>
                <FlowPaneSurface />
              </ReactFlowProvider>
            </LogicFlowOrientationProvider>
          </div>
        </section>
        <div style={SYNTHETIC_INSPECTOR_COLUMN}>
          <SyntheticDataInspector
            occurrenceLabel={selected?.label ?? "No captured occurrence"}
            snapshot={selected?.snapshot ?? null}
            position={selectedIndex < 0 ? undefined : { current: selectedIndex + 1, total: steps.length }}
            experiment={selected?.snapshot === null || selected?.snapshot === undefined ? undefined : {
              activeOverride: selectedOverride,
              watchers: selectedWatchers,
              watchHit: selectedWatchHit,
              onStageOverride: (override) => stageSyntheticInputOverride(execution.rootId, override),
              onRemoveOverride: removeSyntheticInputOverride,
              onAddWatcher: (watcher) => addSyntheticFieldWatcher(execution.rootId, watcher),
              onRemoveWatcher: removeSyntheticFieldWatcher,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function SyntheticFlowToolbar({
  selected,
  orientation,
  presentation,
  onOrientationChange,
  onPresentationChange,
}: {
  selected: SyntheticOccurrenceStep | null;
  orientation: LogicFlowOrientation;
  presentation: "focused" | "overview";
  onOrientationChange(orientation: LogicFlowOrientation): void;
  onPresentationChange(presentation: "focused" | "overview"): void;
}) {
  return (
    <div style={SYNTHETIC_CANVAS_TOOLBAR}>
      <div style={SYNTHETIC_SELECTED_META}>
        <strong style={SYNTHETIC_SELECTED_NAME}>{selected?.label ?? "No captured flow"}</strong>
        {selected === null ? null : (
          <span style={SYNTHETIC_SELECTED_DETAIL}>
            <span style={statusStyle(selected.status)}>{selected.status}</span>
            <span>{formatRequestDuration(selected.durationMs)}</span>
          </span>
        )}
      </div>
      <div style={DISPLAY_CONTROLS}>
        {presentation === "focused" ? (
          <div style={ORIENTATION_CONTROL} role="group" aria-label="Focused flow orientation">
            {(["vertical", "horizontal"] as const).map((value) => (
              <button
                key={value}
                type="button"
                style={orientationButtonStyle(value === orientation)}
                aria-pressed={value === orientation}
                onClick={() => onOrientationChange(value)}
              >
                {value === "vertical" ? "Vertical" : "Horizontal"}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          style={overviewButtonStyle(presentation === "overview")}
          aria-pressed={presentation === "overview"}
          onClick={() => onPresentationChange(presentation === "overview" ? "focused" : "overview")}
        >
          {presentation === "overview" ? "Focused flow" : "Full request"}
        </button>
      </div>
    </div>
  );
}

type AlternateFlowPaneMode = Exclude<ReviewFlowSplitView, "graph">;

function FlowPaneProjection(props: {
  mode: AlternateFlowPaneMode;
  selection: FlowSelectionRef;
  flows: LogicFlows;
  focusRequest: FlowPaneFocusRequest | null;
}) {
  const artifact = useBlueprint((state) => state.artifact);
  const index = useBlueprint((state) => state.index);
  const logicSelected = useBlueprint((state) => state.logicSelected);
  const { selectFlowPaneTarget } = useBlueprintActions();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const steps = useMemo(
    () => stepsAt(props.flows, props.selection) ?? [],
    [props.flows, props.selection],
  );
  const sequenceModel = props.selection.blockPath.length === 0
    ? sequenceTimelineFor(artifact, props.selection.rootId)
      ?? causalSequenceTimelineFor(artifact, props.selection.rootId, index)
    : null;
  const selectedFlowKey = selectionKey(props.selection);

  // Review selections reuse the drawer. A new sequence/blocks flow should begin at its entry,
  // rather than inheriting the vertical position of the flow that was inspected before it.
  useEffect(() => {
    if (props.mode === "metro") return;
    const frame = requestAnimationFrame(() => {
      if (scrollRef.current !== null) {
        scrollRef.current.scrollTop = 0;
        scrollRef.current.scrollLeft = 0;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [props.mode, selectedFlowKey]);

  // Metro's main line sits midway down its full transit-map canvas. On the short review drawer,
  // center that line initially while leaving upper and lower branch lanes reachable by scrolling.
  useEffect(() => {
    if (props.mode !== "metro") {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const surface = scrollRef.current;
      if (surface !== null) {
        surface.scrollTop = Math.max(0, METRO_COMPACT_TOP_PADDING + METRO_MAIN_LINE_Y - surface.clientHeight / 2);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [props.mode, steps]);

  // The header navigator is shared by every review projection. Graph mode moves its camera; the
  // DOM-based projections center their already-selected native button in the split scroller.
  useEffect(() => {
    if (props.focusRequest === null || props.focusRequest.targetId !== logicSelected) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "smooth",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [logicSelected, props.focusRequest]);

  if (steps.length === 0 && !(props.mode === "timeline" && sequenceModel !== null)) {
    return (
      <div style={SURFACE_FILL} data-flow-pane-view={props.mode}>
        <PaneMessage mark="∅" text="This block has no charted call flow." />
      </div>
    );
  }

  const viewProps: FlowViewProps = {
    rootId: props.selection.rootId,
    steps,
    flows: props.flows,
    index,
    selected: logicSelected,
    onSelect: (target) => selectFlowPaneTarget(target === logicSelected ? null : target),
    // The execution-graph split has no drill gesture. Keep parity across review projections; the
    // explicit "Open in Logic flow" action above owns navigation out of the review experience.
    onDrill: () => undefined,
  };

  return (
    <div
      ref={scrollRef}
      style={ALTERNATE_SURFACE}
      data-flow-pane-view={props.mode}
      onClick={() => selectFlowPaneTarget(null)}
    >
      <AlternateProjection
        key={`${props.mode}:${selectedFlowKey}`}
        mode={props.mode}
        viewProps={viewProps}
        sequenceModel={sequenceModel}
      />
    </div>
  );
}

export interface RequestFlowContext {
  requestName: string;
  environment: string | null;
  status: RequestTrace["status"];
  spanCount: number;
  eventCount: number;
  durationMs: number;
  complete: boolean;
}

export function requestFlowContext(
  trace: RequestTrace | null,
  environment: string | null,
): RequestFlowContext | null {
  if (trace === null) return null;
  return {
    requestName: trace.name,
    environment,
    status: trace.status,
    spanCount: trace.spans.length,
    eventCount: trace.spans.reduce((count, span) => count + span.events.length, 0),
    durationMs: Number(BigInt(trace.endedAtUnixNano) - BigInt(trace.startedAtUnixNano)) / 1_000_000,
    complete: trace.completeness.complete,
  };
}

function RequestContext({
  context,
  eyebrow = "REQUEST",
  warnings = [],
  observedEdgeLabel = "telemetry path",
}: {
  context: RequestFlowContext;
  eyebrow?: string;
  warnings?: readonly string[];
  observedEdgeLabel?: string;
}) {
  return (
    <div style={REQUEST_CONTEXT} aria-label="Selected request context">
      <span style={REQUEST_EYEBROW}>{eyebrow}</span>
      <span style={REQUEST_NAME} title={context.requestName}>{context.requestName}</span>
      {context.environment ? <span style={REQUEST_CHIP}>{context.environment}</span> : null}
      <span style={REQUEST_CHIP}>{context.status}</span>
      <span style={REQUEST_CHIP}>{formatRequestDuration(context.durationMs)}</span>
      <span style={REQUEST_CHIP}>{context.spanCount} span{context.spanCount === 1 ? "" : "s"}</span>
      <span style={REQUEST_CHIP}>{context.eventCount} event{context.eventCount === 1 ? "" : "s"}</span>
      <span style={REQUEST_CHIP}>{context.complete ? "complete" : "partial"}</span>
      {warnings.length > 0 ? <span style={SYNTHETIC_WARNING} title={warnings.join("\n")}>{warnings.length} warning{warnings.length === 1 ? "" : "s"}</span> : null}
      <span style={REQUEST_EDGE_LEGEND} aria-label="Request flow edge legend">
        <span style={REQUEST_EDGE_KEY} title={observedEdgeLabel === "telemetry path" ? "Captured telemetry causality" : "Captured synthetic execution causality"}>
          <span style={REQUEST_EDGE_OBSERVED_SWATCH} /> {observedEdgeLabel}
        </span>
        <span style={REQUEST_EDGE_KEY} title="Static code edge without an exact telemetry join">
          <span style={REQUEST_EDGE_CONTEXT_SWATCH} /> code context
        </span>
      </span>
    </div>
  );
}

/** Exhaustive alternate-view dispatch: adding a Logic mode fails type-checking until it has a real
 * split renderer, so a preference can never silently fall back to the execution graph. */
function AlternateProjection(props: {
  mode: AlternateFlowPaneMode;
  viewProps: FlowViewProps;
  sequenceModel: SequenceTimelineModel | null;
}) {
  switch (props.mode) {
    case "timeline":
      return (
        <TimelineView
          {...props.viewProps}
          density="compact"
          drillEnabled={false}
          showZoomControls
          modelOverride={props.sequenceModel}
        />
      );
    case "metro":
      return <MetroView {...props.viewProps} density="compact" drillEnabled={false} />;
    case "blocks":
      return <BlocksView {...props.viewProps} density="compact" drillEnabled={false} />;
    default:
      return assertNever(props.mode);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported flow-pane projection: ${String(value)}`);
}

function formatRequestDuration(durationMs: number): string {
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(2)}s`;
  if (durationMs >= 10) return `${durationMs.toFixed(1)}ms`;
  return `${durationMs.toFixed(2)}ms`;
}

function FlowPaneSurface({ focusRequest = null }: { focusRequest?: FlowPaneFocusRequest | null }) {
  const nodes = useBlueprint((state) => state.flowPaneRfNodes);
  const edges = useBlueprint((state) => state.flowPaneRfEdges);
  const status = useBlueprint((state) => state.flowPaneLayoutStatus);
  const logicSelected = useBlueprint((state) => state.logicSelected);
  const reviewCodePreviewEnabled = useBlueprint(
    (state) => state.flowSelection !== null && state.reviewFlowBaseline !== null,
  );
  const reviewCodePreviewTrigger = useBlueprint((state) => state.reviewCodePreviewTrigger);
  const executionOpen = useBlueprint((state) => state.flowPaneOrigin === "request" || state.flowPaneOrigin === "synthetic");
  const syntheticOpen = useBlueprint((state) => state.flowPaneOrigin === "synthetic");
  const syntheticPresentation = useBlueprint((state) => state.syntheticFlowPresentation);
  const {
    selectFlowPaneTarget,
    selectSyntheticMoment,
    toggleFlowPaneExpand,
    toggleRequestFlowExpand,
    toggleFlowPaneEdgeCollapse,
    openLogicFlow,
  } = useBlueprintActions();
  const nodeDiff = useNodeDiffPreview(
    reviewCodePreviewEnabled,
    reviewCodePreviewTrigger,
    flowPaneCodePreviewTarget,
  );
  const focusedSynthetic = syntheticOpen && syntheticPresentation === "focused";
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fittedNodes = useRef<readonly Node[] | null>(null);
  // The surface is mounted under a selection/trace-specific ReactFlowProvider key, so this resets
  // on navigation. Same-flow node or edge disclosure relayouts keep the mount and must preserve the
  // viewport the reader panned to instead of jumping back to the whole graph.
  const initialFitDone = useRef(false);

  const fitReadyNodes = (instance: ReactFlowInstance<Node, Edge>) => {
    if (status !== "ready" || nodes.length === 0 || fittedNodes.current === nodes) {
      return;
    }
    fittedNodes.current = nodes;
    if (!shouldAutoFitFlowPane(executionOpen, initialFitDone.current)) {
      return;
    }
    initialFitDone.current = true;
    requestAnimationFrame(() => {
      // A whole request can contain dozens of runtime moments. Fitting every card turns the split
      // into an unreadable miniature timeline, so request mode opens on the entry + first four
      // moments at reading scale; the canvas and minimap retain the rest of the horizontal chain.
      // Nested static Exec bodies are emitted immediately after their runtime parent. Fit the first
      // five TOP-LEVEL request moments, not the first five raw RF nodes, so an expanded callable is
      // treated as one readable unit and the opening camera still advances along the request.
      const requestMoments = executionOpen ? nodes.filter((node) => node.parentId === undefined) : nodes;
      const focusedRoot = focusedSynthetic ? requestMoments[0] : undefined;
      const focusedChildren = focusedRoot === undefined
        ? []
        : nodes.filter((node) => node.parentId === focusedRoot.id)
          .slice(0, 2);
      const openingNodes = focusedSynthetic
        ? focusedChildren.length > 0 ? focusedChildren : requestMoments.slice(0, 1)
        : executionOpen
          ? requestMoments.slice(0, Math.min(requestMoments.length, 5))
          : nodes;
      if (focusedSynthetic && focusedChildren.length > 0) {
        const center = focusedOpeningCenter(focusedChildren, nodes);
        void instance.setCenter(center.x, center.y, { zoom: 1, duration: 0 });
        return;
      }
      // #182's explicit joins and async rails make the opening request bounds taller. Let fitView
      // zoom out far enough to keep title controls inside the usable canvas below the pane header.
      void instance.fitView({
        nodes: openingNodes,
        padding: focusedSynthetic ? 0.24 : 0.16,
        minZoom: focusedSynthetic ? 0.78 : executionOpen ? 0.42 : undefined,
        maxZoom: focusedSynthetic ? 1.1 : 1.25,
      });
    });
  };

  useEffect(() => {
    if (!rfRef.current) {
      return;
    }
    fitReadyNodes(rfRef.current);
  }, [nodes, status]);

  useEffect(() => {
    if (
      focusRequest === null
      || logicSelected !== focusRequest.targetId
      || status !== "ready"
      || rfRef.current === null
    ) {
      return;
    }
    const target = flowPaneFocusNode(nodes, focusRequest.targetId);
    if (target === null) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      void rfRef.current?.fitView({ nodes: [target], padding: 0.55, duration: 350, maxZoom: 1.25 });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, logicSelected, nodes, status]);

  if (nodes.length === 0 && status === "laying-out") {
    return <GraphSurface><PaneMessage mark="…" text="Laying out flow." /></GraphSurface>;
  }
  if (nodes.length === 0 && status === "ready") {
    return (
      <GraphSurface>
        <PaneMessage mark="∅" text={executionOpen ? "No execution steps were captured for this run." : "This block has no charted call flow."} />
      </GraphSurface>
    );
  }
  if (status === "error") {
    return <GraphSurface><PaneMessage mark="!" text="Could not lay out this flow." /></GraphSurface>;
  }
  return (
    <GraphSurface>
      <BaseNodeActionScope
        toggleExpand={(model) => {
          if (executionOpen) {
            toggleRequestFlowExpand(model.instanceId);
          } else {
            toggleFlowPaneExpand(model.instanceId);
          }
        }}
        navigateInto={(model) => {
          const target = flowPaneNavigationTarget(model);
          if (target !== null) {
            openLogicFlow(target);
          }
        }}
      >
        <LogicEdgeActionScope toggleCollapse={toggleFlowPaneEdgeCollapse}>
          <ReactFlow<Node, Edge>
            {...READONLY_CANVAS_PROPS}
            nodes={nodes}
            edges={edges}
            nodeTypes={logicNodeTypes}
            edgeTypes={logicEdgeTypes}
            fitViewOptions={focusedSynthetic ? { padding: 0.2, minZoom: 0.78, maxZoom: 1.5 } : READONLY_CANVAS_PROPS.fitViewOptions}
            minZoom={focusedSynthetic ? 0.78 : READONLY_CANVAS_PROPS.minZoom}
            maxZoom={focusedSynthetic ? 1.5 : READONLY_CANVAS_PROPS.maxZoom}
            onInit={(instance) => {
              rfRef.current = instance;
              fittedNodes.current = null;
              fitReadyNodes(instance);
            }}
            onNodeClick={(event, node) => {
              if (reviewCodePreviewEnabled) {
                nodeDiff.onNodeClick(event, node);
              }
              const target = artifactTargetOf(node);
              if (syntheticOpen) {
                const runtime = (node.data as Partial<LogicNodeData>).runtime;
                if (runtime !== undefined) {
                  selectSyntheticMoment(node.id, target);
                } else if (target !== null) {
                  selectFlowPaneTarget(target);
                }
                return;
              }
              if (target !== null) {
                // Request occurrences always reveal their exact mapped artifact node. Static/review flows
                // retain their historical toggle-by-target behavior through `logicSelected`.
                selectFlowPaneTarget(executionOpen ? target : target === logicSelected ? null : target);
              }
            }}
            onNodeMouseEnter={reviewCodePreviewEnabled ? nodeDiff.onNodeMouseEnter : undefined}
            onNodeMouseMove={reviewCodePreviewEnabled ? nodeDiff.onNodeMouseMove : undefined}
            onNodeMouseLeave={reviewCodePreviewEnabled ? nodeDiff.onNodeMouseLeave : undefined}
            onPaneMouseMove={reviewCodePreviewEnabled ? nodeDiff.onPaneMouseMove : undefined}
            onPaneClick={() => {
              if (reviewCodePreviewEnabled) {
                nodeDiff.onPaneClick();
              }
              selectFlowPaneTarget(null);
            }}
          >
            <CanvasChrome nodeColor={miniMapColor} />
          </ReactFlow>
        </LogicEdgeActionScope>
      </BaseNodeActionScope>
      {nodeDiff.layer}
    </GraphSurface>
  );
}

function GraphSurface(props: { children: React.ReactNode }) {
  return <div style={SURFACE_FILL} data-flow-pane-view="graph">{props.children}</div>;
}

/** Every pane fits once per selection/trace mount, then preserves the reader's camera across node
 * and edge disclosure relayouts. Exported only as a pure policy seam for focused regressions. */
export function shouldAutoFitFlowPane(_requestOpen: boolean, initialFitDone: boolean): boolean {
  return !initialFitDone;
}

/** React Flow stores nested child positions relative to their containers. Center the first two
 * focused steps at reading zoom without fitting the selected callable's entire (possibly very long)
 * container back into a thumbnail. */
export function focusedOpeningCenter(
  openingNodes: readonly Node[],
  allNodes: readonly Node[],
): { x: number; y: number } {
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const rects = openingNodes.map((node) => absoluteNodeRect(node, byId));
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

function absoluteNodeRect(
  node: Node,
  byId: ReadonlyMap<string, Node>,
): { x: number; y: number; width: number; height: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const visited = new Set<string>();
  while (parentId !== undefined && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y, width: node.width ?? 0, height: node.height ?? 0 };
}

/** The split pane uses the same double-click navigation contract as the main Logic canvas. Static
 * call occurrences open their canonical callee; structural and runtime-only moments deliberately
 * remain in-pane because they have no independently navigable artifact target. */
export function flowPaneNavigationTarget(
  model: Pick<BaseNodeModel, "targetId" | "canNavigate">,
): string | null {
  return model.canNavigate && model.targetId !== null ? model.targetId : null;
}

/** Static call blocks and request runtime moments map directly to their artifact target. Structural
 * controls plus entry/exit caps have no standalone graph node and intentionally do nothing. */
function artifactTargetOf(node: Node): string | null {
  const data = node.data as { targetId?: unknown };
  if (typeof data.targetId === "string") {
    return data.targetId;
  }
  return null;
}

/** Calls retain the graph-view contract and preview their callee. Structural controls have no
 * standalone GraphNode, so they load their canonical enclosing callable and carry the exact
 * statement only as a presentation focus. Joins/terminals/services remain intentionally inert. */
export function flowPaneCodePreviewTarget(node: Node): string | CodePreviewTarget | null {
  const data = node.data as Partial<LogicNodeData>;
  if (typeof data.targetId === "string") {
    return data.targetId;
  }
  const sourceContext = data.sourceContext;
  if (sourceContext === undefined || typeof sourceContext.ownerId !== "string") {
    return null;
  }
  return {
    targetId: sourceContext.ownerId,
    ...(sourceContext.anchor ? { focus: sourceContext.anchor } : {}),
    ...(typeof data.label === "string" ? { label: data.label } : {}),
  };
}

/** The navigator focuses the first visible occurrence of a changed callable. A changed flow root is
 * represented by its synthetic entry cap (which intentionally has no artifact target), so retain
 * that exact fallback without broad id substring matching. */
export function flowPaneFocusNode(nodes: readonly Node[], targetId: string): Node | null {
  return nodes.find((node) => node.id === `${targetId}::entry`)
    ?? nodes.find((node) => artifactTargetOf(node) === targetId)
    ?? null;
}

function PaneMessage(props: { mark: string; text: string }) {
  return (
    <div style={EMPTY}>
      <span style={EMPTY_MARK}>{props.mark}</span>
      <span>{props.text}</span>
    </div>
  );
}

function miniMapColor(node: Node): string {
  const data = node.data as LogicNodeData;
  if (data.runtime?.status === "error") return "#D75B64";
  if (data.runtime?.kind === "span") return "#58C9A3";
  if (data.runtime?.kind === "branch") return "#E6B84D";
  if (data.runtime?.kind === "loop") return "#61C4D8";
  if (data.runtime?.kind === "exception") return "#D98A5B";
  if (data.runtime?.kind === "async") return "#9B7BD8";
  if (data.changedStatus !== undefined) return changedColor(data.changedStatus);
  if (data.targetChangedStatus !== undefined) return changedColor(data.targetChangedStatus);
  if (data.logicKind === "loop") return "#E6B84D";
  if (data.logicKind === "try") return "#D98A5B";
  if (data.logicKind === "if" || data.logicKind === "switch") return "#61DAFB";
  return data.greyed ? "#3A414C" : "#3B7AC0";
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const DRAWER: React.CSSProperties = {
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  background: "#0B0E13",
  color: "#D6DEE9",
};

const HEADER: React.CSSProperties = {
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 12px",
  borderBottom: "1px solid #1B2028",
  background: "#0E1116",
};

const TITLE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const GLYPH: React.CSSProperties = { color: "#56C271", fontSize: 13, flexShrink: 0 };
const TITLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: MONO,
  fontSize: 12.5,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const OPEN_BUTTON: React.CSSProperties = {
  border: "1px solid #2A313D",
  borderRadius: 5,
  background: "#151B24",
  color: "#C9D3E0",
  padding: "4px 8px",
  fontSize: 12,
  cursor: "pointer",
};
const CHANGE_NAV: React.CSSProperties = { minWidth: 0, maxWidth: 300, display: "inline-flex", alignItems: "center", gap: 4, flex: "0 1 300px" };
const CHANGE_ARROW: React.CSSProperties = {
  width: 22,
  height: 22,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "1px solid #343C49",
  borderRadius: 5,
  background: "#111720",
  color: "#AAB6C5",
  cursor: "pointer",
  fontSize: 16,
  lineHeight: 1,
};
const CHANGE_FOCUS: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  maxWidth: 300,
  height: 24,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0 8px",
  border: "1px solid",
  borderRadius: 6,
  cursor: "pointer",
  font: "inherit",
  fontSize: 10,
  boxShadow: "0 0 12px currentColor",
};
const CHANGE_GLYPH: React.CSSProperties = { fontSize: 11, fontWeight: 900, lineHeight: 1, flexShrink: 0 };
const CHANGE_STATUS: React.CSSProperties = { fontWeight: 800, letterSpacing: "0.06em", flexShrink: 0 };
const CHANGE_NAME: React.CSSProperties = { color: "#D6DEE9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: MONO };
const CLOSE: React.CSSProperties = { width: 22, height: 22, border: "1px solid #2A313D", borderRadius: 5, background: "transparent", color: "#9AA4B2", cursor: "pointer", fontSize: 11, lineHeight: 1 };
const BREADCRUMBS: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, minWidth: 0 };
const REQUEST_CONTEXT: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontFamily: MONO, fontSize: 10.5 };
const REQUEST_EYEBROW: React.CSSProperties = { color: "#58C9A3", fontSize: 9, fontWeight: 750, letterSpacing: "0.09em" };
const REQUEST_NAME: React.CSSProperties = { minWidth: 0, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#AAB6C5" };
const REQUEST_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid #2A3742", borderRadius: 999, padding: "1px 6px", color: "#8FA0B2" };
const SYNTHETIC_WARNING: React.CSSProperties = { ...REQUEST_CHIP, borderColor: "#66542E", color: "#D4B56A" };
const REQUEST_EDGE_LEGEND: React.CSSProperties = { marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0, color: "#788898", fontSize: 9 };
const REQUEST_EDGE_KEY: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" };
const REQUEST_EDGE_OBSERVED_SWATCH: React.CSSProperties = { width: 18, height: 0, borderTop: "3px solid #C8D3E0", borderRadius: 999, filter: "drop-shadow(0 0 3px rgba(88, 201, 163, 0.95))" };
const REQUEST_EDGE_CONTEXT_SWATCH: React.CSSProperties = { width: 18, height: 0, borderTop: "1px solid rgba(200, 211, 224, 0.32)" };
const CRUMB_GROUP: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, minWidth: 0 };
const CRUMB_SEP: React.CSSProperties = { color: "#4E5867", fontSize: 12 };
const CRUMB: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#98A3B3",
  padding: 0,
  fontSize: 11.5,
  cursor: "pointer",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const BODY: React.CSSProperties = { position: "relative", flex: 1, minHeight: 0 };
const SURFACE_FILL: React.CSSProperties = { position: "relative", width: "100%", height: "100%" };
const SYNTHETIC_PLAYER: React.CSSProperties = {
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  display: "grid",
  gridTemplateRows: "auto auto minmax(0, 1fr)",
  gap: 8,
  padding: 8,
  boxSizing: "border-box",
  overflow: "hidden",
  background: "#090C11",
};
function syntheticExperimentRowStyle(hasComparison: boolean): React.CSSProperties {
  return {
    minWidth: 0,
    maxHeight: "min(34vh, 270px)",
    display: "grid",
    gridTemplateColumns: hasComparison
      ? "minmax(430px, 1.25fr) minmax(300px, 0.8fr)"
      : "minmax(0, 1fr)",
    gap: 8,
    overflow: "auto",
    overscrollBehavior: "contain",
  };
}
const SYNTHETIC_PLAYER_CONTENT: React.CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "minmax(360px, 1.55fr) minmax(300px, 0.9fr)",
  gap: 8,
};
const SYNTHETIC_CANVAS_COLUMN: React.CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr)",
  overflow: "hidden",
  border: "1px solid #27313C",
  borderRadius: 8,
  background: FLOW_COLORS.canvas,
};
const SYNTHETIC_CANVAS_TOOLBAR: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "7px 9px",
  borderBottom: "1px solid #202833",
  background: "#0E131A",
  fontFamily: MONO,
};
const SYNTHETIC_SELECTED_META: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 8,
};
const SYNTHETIC_SELECTED_NAME: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#E3EBF2",
  fontSize: 11,
};
const SYNTHETIC_SELECTED_DETAIL: React.CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  color: "#8795A4",
  fontSize: 9,
  fontVariantNumeric: "tabular-nums",
};
const DISPLAY_CONTROLS: React.CSSProperties = { flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6 };
const ORIENTATION_CONTROL: React.CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  padding: 2,
  border: "1px solid #2B3541",
  borderRadius: 6,
  background: "#090D12",
};
const SYNTHETIC_CANVAS: React.CSSProperties = { position: "relative", minWidth: 0, minHeight: 0 };
const SYNTHETIC_INSPECTOR_COLUMN: React.CSSProperties = { minWidth: 0, minHeight: 0, overflow: "hidden" };

function orientationButtonStyle(selected: boolean): React.CSSProperties {
  return {
    minWidth: 74,
    border: "none",
    borderRadius: 4,
    background: selected ? "#58C9A3" : "transparent",
    color: selected ? "#07120E" : "#8C9AAA",
    padding: "4px 8px",
    fontFamily: MONO,
    fontSize: 9,
    fontWeight: selected ? 750 : 600,
    cursor: "pointer",
  };
}

function overviewButtonStyle(selected: boolean): React.CSSProperties {
  return {
    minWidth: 88,
    border: selected ? "1px solid #58C9A377" : "1px solid transparent",
    borderRadius: 4,
    background: selected ? "rgba(88,201,163,0.1)" : "transparent",
    color: selected ? "#8DE0C2" : "#9AA8B7",
    padding: "3px 8px",
    fontFamily: MONO,
    fontSize: 9,
    fontWeight: 650,
    cursor: "pointer",
  };
}

function statusStyle(status: SyntheticOccurrenceStep["status"]): React.CSSProperties {
  const color = status === "error" ? "#F0787C" : status === "ok" ? "#65D5AE" : "#8B98A6";
  return {
    border: `1px solid ${color}66`,
    borderRadius: 999,
    background: `${color}12`,
    color,
    padding: "1px 5px",
    fontSize: 8,
    textTransform: "uppercase",
  };
}
const ALTERNATE_SURFACE: React.CSSProperties = {
  ...SURFACE_FILL,
  overflow: "auto",
  overscrollBehavior: "contain",
  backgroundColor: FLOW_COLORS.canvas,
  backgroundImage: "radial-gradient(#1B2230 1px, transparent 1px)",
  backgroundSize: "22px 22px",
};
const EMPTY: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  color: "#6B7482",
  fontSize: 12.5,
};
const EMPTY_MARK: React.CSSProperties = { fontSize: 26, color: "#3A414C" };
