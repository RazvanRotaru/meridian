/**
 * Public surface of the design-metrics package: Martin's component-design metrics + LCOM4 cohesion
 * (composition), the graph primitives they read (composition-graph), and the per-unit diagnosis +
 * scores glossary (compositionAdvice). Graph in, metrics/advice out — no React, no DOM.
 */

export * from "./composition";
export * from "./composition-graph";
export * from "./compositionAdvice";
export * from "./service-topology";
