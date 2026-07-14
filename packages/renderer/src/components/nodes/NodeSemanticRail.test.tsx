import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SEMANTIC_STATE_TEXT_MAX_WIDTH } from "../../nodeSemantics";
import { NodeKindBadge, NodeSemanticRail } from "./NodeSemanticRail";

describe("shared node semantic rail", () => {
  it("states declaration, Promise result, and awaited occurrence without conflating them", () => {
    const markup = renderToStaticMarkup(
      <NodeSemanticRail semantics={{
        modifiers: ["async", "static"],
        returnsPromise: true,
        asyncState: { kind: "awaited" },
      }} />,
    );

    expect(markup).toContain("ASYNC");
    expect(markup).toContain("STATIC");
    expect(markup).toContain("PROMISE");
    expect(markup).toContain("AWAITED");
    expect(markup).toContain('aria-label="Async declaration · Returns a Promise · This call is awaited"');
  });

  it("labels a launch without falsely claiming it is not awaited", () => {
    const markup = renderToStaticMarkup(
      <NodeSemanticRail semantics={{
        returnsPromise: true,
        asyncState: { kind: "launched", binding: "pendingOrder" },
      }} />,
    );

    expect(markup).toContain("PROMISE");
    expect(markup).toContain("LAUNCHED · pendingOrder");
    expect(markup).not.toContain("NOT AWAITED");
    expect(markup).toContain("may be joined later");
  });

  it("caps a generated launch binding while keeping its full accessible explanation", () => {
    const binding = "generatedBindingWithAnExtremelyLongIdentifierThatMustNotDisplaceActions";
    const markup = renderToStaticMarkup(
      <NodeSemanticRail semantics={{
        returnsPromise: true,
        asyncState: { kind: "launched", binding },
      }} />,
    );

    expect(markup).toContain(`Promise launched as ${binding}`);
    expect(markup).toContain(`max-width:${SEMANTIC_STATE_TEXT_MAX_WIDTH}px`);
    expect(markup).toContain("text-overflow:ellipsis");
  });

  it("distinguishes a proven detached Promise from an arbitrary dropped result", () => {
    const promise = renderToStaticMarkup(
      <NodeSemanticRail semantics={{ returnsPromise: true, asyncState: { kind: "detached" } }} />,
    );
    const unknown = renderToStaticMarkup(
      <NodeSemanticRail semantics={{ asyncState: { kind: "detached" } }} />,
    );

    expect(promise).toContain("PROMISE");
    expect(promise).toContain("NOT AWAITED");
    expect(unknown).toContain("RESULT DROPPED");
    expect(unknown).not.toContain("NOT AWAITED");
  });

  it("keeps nested detached work separate from the parent occurrence", () => {
    const markup = renderToStaticMarkup(
      <NodeSemanticRail semantics={{ nestedNotAwaited: 3 }} />,
    );

    expect(markup).toContain("3 NOT AWAITED INSIDE");
    expect(markup).toContain('data-node-semantic-nested-not-awaited="3"');
  });

  it("does not call an unproven nested dropped result a Promise", () => {
    const markup = renderToStaticMarkup(
      <NodeSemanticRail semantics={{ nestedResultsDropped: 2 }} />,
    );

    expect(markup).toContain("2 RESULTS DROPPED INSIDE");
    expect(markup).not.toContain("NOT AWAITED");
    expect(markup).toContain('data-node-semantic-nested-results-dropped="2"');
  });

  it("uses singular copy for one nested dropped result", () => {
    const markup = renderToStaticMarkup(
      <NodeSemanticRail semantics={{ nestedResultsDropped: 1 }} />,
    );

    expect(markup).toContain("1 RESULT DROPPED INSIDE");
    expect(markup).not.toContain("1 RESULTS");
  });

  it("humanizes open-vocabulary node kinds in the shared identity slot", () => {
    const markup = renderToStaticMarkup(<NodeKindBadge kind="typeAlias" />);
    expect(markup).toContain("TYPE ALIAS");
    expect(markup).toContain('data-node-kind-label="typeAlias"');
    expect(markup).toContain("color:#D6DEE8");
  });
});
