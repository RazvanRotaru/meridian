import { useEffect, useMemo, useState } from "react";
import type { JsonValue, NodeId, SyntheticExecution, SyntheticScenarioDescriptor } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { SyntheticExecutionHost } from "../../state/store";
import type { SyntheticExecutionTrust } from "../../state/syntheticExecutionTrust";

export type SyntheticExecutionStatus = "idle" | "running" | "ready" | "error";
export type SyntheticExecutionAvailability = "ready" | "execution-unavailable" | "scenario-required";

export interface SyntheticExecutionController {
  canGenerate: boolean;
  executionTrust: SyntheticExecutionTrust | null;
  sandboxConsent: boolean;
  availability: SyntheticExecutionAvailability;
  availabilityMessage: string | null;
  execution: SyntheticExecution | null;
  executionOpen: boolean;
  editorOpen: boolean;
  input: string;
  inputError: string | null;
  scenario: SyntheticScenarioDescriptor | null;
  scenarios: SyntheticScenarioDescriptor[];
  status: SyntheticExecutionStatus;
  error: string | null;
  buttonLabel: string;
  toggleEditor(): void;
  setInput(value: string): void;
  setSandboxConsent(consent: boolean): void;
  selectScenario(id: string): void;
  cancelEditor(): void;
  submit(): void;
  clear(): void;
}

export function useSyntheticExecutionController(
  rootId: NodeId | null,
  host: SyntheticExecutionHost,
): SyntheticExecutionController {
  const endpoint = useBlueprint((state) => state.syntheticExecutionUrl);
  const executionTrust = useBlueprint((state) => state.syntheticExecutionTrust);
  const catalog = useBlueprint((state) => state.syntheticScenarios);
  const execution = useBlueprint((state) => state.syntheticExecution);
  const runRootId = useBlueprint((state) => state.syntheticExecutionRootId);
  const globalStatus = useBlueprint((state) => state.syntheticExecutionStatus);
  const globalError = useBlueprint((state) => state.syntheticExecutionError);
  const editorRequest = useBlueprint((state) => state.syntheticEditorRequest);
  const { runSyntheticExecution, clearSyntheticExecution, consumeSyntheticEditorRequest } = useBlueprintActions();
  const [editorOpen, setEditorOpen] = useState(false);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [globalErrorDismissed, setGlobalErrorDismissed] = useState(false);
  const [sandboxConsent, setSandboxConsent] = useState(false);

  const scenarios = useMemo(
    () => syntheticScenariosForRoot(catalog, rootId),
    [catalog, rootId],
  );
  const executionScenarioId = execution?.rootId === rootId ? execution.scenarioId : null;
  const scenario = preferredSyntheticScenario(scenarios, scenarioId ?? executionScenarioId);
  const consentScope = syntheticConsentScopeKey({
    endpoint,
    trust: executionTrust,
    rootId,
    scenarioId: scenario?.id ?? null,
  });
  const status = runRootId === rootId ? globalStatus : "idle";
  const error = runRootId === rootId && !globalErrorDismissed ? globalError : null;
  const executionOpen = execution?.rootId === rootId && globalStatus === "ready";

  useEffect(() => {
    setScenarioId((current) => preferredSyntheticScenario(
      scenarios,
      current ?? executionScenarioId,
    )?.id ?? null);
  }, [executionScenarioId, scenarios]);

  useEffect(() => {
    if (scenario === null) {
      setInput("");
      setInputError(null);
      return;
    }
    const value = execution?.scenarioId === scenario.id
      ? execution.input
      : scenario.defaultInput;
    setInput(formatSyntheticInputJson(value));
    setInputError(null);
  }, [execution, scenario]);

  useEffect(() => {
    if (status === "ready") {
      setEditorOpen(false);
      setSandboxConsent(false);
    }
  }, [status]);

  // Consent is deliberately component-local: it does not survive an editor open, root/scenario
  // switch, remount, URL sync, or browser refresh.
  useEffect(() => {
    setSandboxConsent(false);
  }, [consentScope]);

  useEffect(() => {
    setGlobalErrorDismissed(false);
  }, [globalError]);

  useEffect(() => {
    if (rootId === null || editorRequest?.rootId !== rootId || editorRequest.host !== host) return;
    setSandboxConsent(false);
    setEditorOpen(true);
    consumeSyntheticEditorRequest(rootId, host);
  }, [consumeSyntheticEditorRequest, editorRequest, host, rootId]);

  const availability: SyntheticExecutionAvailability = endpoint === null || executionTrust === null
    ? "execution-unavailable"
    : scenario === null
      ? "scenario-required"
      : "ready";
  const availabilityMessage = availability === "execution-unavailable"
    ? "Synthetic execution is not enabled for this session. Open this repository in a trusted local or isolated PR execution session to run code."
    : availability === "scenario-required"
      ? "This flow has no runnable synthetic scenario yet. Generate or add a bounded execution harness before running it."
      : null;
  const canGenerate = rootId !== null && availability === "ready";
  const submit = () => {
    if (rootId === null || scenario === null || executionTrust === null) return;
    try {
      const parsed = JSON.parse(input) as JsonValue;
      setInputError(null);
      setGlobalErrorDismissed(false);
      if (executionTrust.mode === "sandboxed-pr" && !sandboxConsent) {
        setInputError("Confirm the untrusted PR sandbox before running code.");
        return;
      }
      void runSyntheticExecution({
        rootId,
        scenarioId: scenario.id,
        input: parsed,
        host,
        sandboxConsent: executionTrust.mode === "sandboxed-pr" ? true : undefined,
      });
    } catch {
      setInputError("Input must be valid JSON.");
    }
  };

  return {
    canGenerate,
    executionTrust,
    sandboxConsent,
    availability,
    availabilityMessage,
    execution,
    executionOpen,
    editorOpen,
    input,
    inputError,
    scenario,
    scenarios,
    status,
    error,
    buttonLabel: status === "running" ? "Running…" : executionOpen ? "Regenerate" : "Generate synthetic data",
    toggleEditor: () => {
      setSandboxConsent(false);
      setEditorOpen((open) => !open);
    },
    setInput: (value) => {
      setInput(value);
      setInputError(null);
      setGlobalErrorDismissed(true);
    },
    setSandboxConsent: (consent) => {
      setSandboxConsent(consent);
      setInputError(null);
    },
    selectScenario: (id) => {
      setScenarioId(id);
      setSandboxConsent(false);
      setInputError(null);
      setGlobalErrorDismissed(true);
    },
    cancelEditor: () => { setEditorOpen(false); setSandboxConsent(false); setInputError(null); },
    submit,
    clear: clearSyntheticExecution,
  };
}

/** Every server/source identity component participates in consent scope. A prepared refresh may
 * keep the same mounted editor and mode while exchanging its endpoint or immutable PR revision. */
export function syntheticConsentScopeKey(args: {
  endpoint: string | null;
  trust: SyntheticExecutionTrust | null;
  rootId: string | null;
  scenarioId: string | null;
}): string {
  return JSON.stringify([
    args.endpoint,
    args.trust?.mode ?? null,
    args.trust?.provenance?.repository ?? null,
    args.trust?.provenance?.headSha ?? null,
    args.rootId,
    args.scenarioId,
  ]);
}

export function syntheticScenariosForRoot(
  scenarios: readonly SyntheticScenarioDescriptor[],
  rootId: string | null,
): SyntheticScenarioDescriptor[] {
  return rootId === null ? [] : scenarios.filter((scenario) => scenario.rootId === rootId);
}

export function preferredSyntheticScenario(
  scenarios: readonly SyntheticScenarioDescriptor[],
  preferredId: string | null,
): SyntheticScenarioDescriptor | null {
  return (preferredId === null ? undefined : scenarios.find((scenario) => scenario.id === preferredId))
    ?? scenarios[0]
    ?? null;
}

export function formatSyntheticInputJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2) ?? "null";
}
