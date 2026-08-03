import { Project, ts, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";
import type { LoadedProject } from "../project-loader";
import { importedSymbolReference } from "../import-reference";
import { throughLocalReexports } from "../reexport-reference";
import {
  collectSemanticCompilerObservations,
  inspectSemanticCompilerObservation,
  type InspectedSemanticCompilerFileObservation,
  type SemanticCompilerFileObservation,
} from "./semantic-compiler-observations";

const CONSUMER = "repo:src/consumer.ts";

describe("semantic compiler observations", () => {
  it("is deterministic for an unchanged Program, including reversed source insertion order", () => {
    const files = {
      "src/consumer.ts": [
        'import { decide } from "./provider";',
        "export const decision = decide();",
        "",
      ].join("\n"),
      "src/provider.ts": [
        "export function decide(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    };
    const forward = loadedProject("/determinism/forward", files);
    const reversed = loadedProject("/determinism/reversed", files, true);

    expect(collectSemanticCompilerObservations(forward))
      .toEqual(collectSemanticCompilerObservations(forward));
    expect(collectSemanticCompilerObservations(reversed))
      .toEqual(collectSemanticCompilerObservations(forward));
  });

  it("distinguishes a local shadow from the imported binding with the same spelling", () => {
    const consumerSource = [
      'import { token } from "./provider";',
      "export const importedResult = token;",
      "export function useLocal(token: string): string {",
      "  return token;",
      "}",
      "",
    ].join("\n");
    const loaded = loadedProject("/shadow", {
      "src/consumer.ts": consumerSource,
      "src/provider.ts": 'export const token = "provider";\n',
    });
    const inspected = inspectSemanticCompilerObservation(loaded, CONSUMER);
    const importedUse = bindingAt(
      inspected,
      consumerSource.indexOf("token;", consumerSource.indexOf("importedResult")),
    );
    const localUse = bindingAt(inspected, consumerSource.lastIndexOf("token;"));

    expect(declarationAddresses(importedUse.value.observed.aliased))
      .toEqual(["repo:src/provider.ts"]);
    expect(importedUse.value.observed.direct?.declarations)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ address: CONSUMER }),
      ]));
    expect(localUse.value.observed.aliased).toBeNull();
    expect(declarationAddresses(localUse.value.observed.direct))
      .toEqual([CONSUMER]);
    expect(inspected.providerAddresses).toContain("repo:src/provider.ts");
  });

  it("changes the consumer transcript when an unresolved global becomes declared", () => {
    const consumer = "export const lateValue = LateGlobal;\n";
    const unresolved = collectSemanticCompilerObservations(
      loadedProject("/global/unresolved", { "src/consumer.ts": consumer }),
    );
    const resolved = collectSemanticCompilerObservations(
      loadedProject("/global/resolved", {
        "src/consumer.ts": consumer,
        "src/globals.ts": "declare const LateGlobal: string;\n",
      }),
    );
    const before = fileObservation(unresolved.files, CONSUMER);
    const after = fileObservation(resolved.files, CONSUMER);

    expect(after.digest).not.toBe(before.digest);
    expect(after.providerAddresses).toContain("repo:src/globals.ts");
    const inspected = inspectSemanticCompilerObservation(
      loadedProject("/global/inspected", {
        "src/consumer.ts": consumer,
        "src/globals.ts": "declare const LateGlobal: string;\n",
      }),
      CONSUMER,
    );
    const lateGlobal = bindingAt(inspected, consumer.indexOf("LateGlobal"));
    expect(declarationAddresses(lateGlobal.value.observed.direct))
      .toEqual(["repo:src/globals.ts"]);
  });

  it("observes a provider shorthand's value-symbol chain used by target resolution", () => {
    const common = {
      "src/consumer.ts": [
        'import { binding } from "./provider";',
        "export function use(): void { binding.replay(); }",
        "",
      ].join("\n"),
      "src/provider.ts": [
        "export function makeBinding() {",
        "  return { replay };",
        "}",
        "export const binding = makeBinding();",
        "",
      ].join("\n"),
    };
    const before = fileObservation(
      collectSemanticCompilerObservations(
        loadedProject("/shorthand-value", common),
      ).files,
      CONSUMER,
    );
    const after = fileObservation(
      collectSemanticCompilerObservations(
        loadedProject("/shorthand-value", {
          ...common,
          "src/globals.ts": "declare function replay(): void;\n",
        }),
      ).files,
      CONSUMER,
    );

    // resolveTarget follows ShorthandPropertyAssignment.getValueSymbol() in provider.ts. The
    // consumer's ordinary callee symbol remains the same provider shorthand in both Programs, so
    // the exact value-symbol trace must bind the newly selected global declaration explicitly.
    expect(after.digest).not.toBe(before.digest);
    expect(before.providerAddresses).not.toContain("repo:src/globals.ts");
    expect(after.providerAddresses).toEqual(expect.arrayContaining([
      "repo:src/globals.ts",
      "repo:src/provider.ts",
    ]));
  });

  it("observes declarations contributed by an external-module augmentation", () => {
    const consumer = [
      'import type { Box } from "./provider";',
      "export type BoxKeys = keyof Box;",
      "",
    ].join("\n");
    const baseFiles = {
      "src/consumer.ts": consumer,
      "src/provider.ts": "export interface Box { value: string; }\n",
    };
    const before = collectSemanticCompilerObservations(
      loadedProject("/augmentation/before", baseFiles),
    );
    const afterLoaded = loadedProject("/augmentation/after", {
      ...baseFiles,
      "src/augmentation.ts": [
        "export {};",
        'declare module "./provider" {',
        "  interface Box { count: number; }",
        "}",
        "",
      ].join("\n"),
    });
    const after = collectSemanticCompilerObservations(afterLoaded);

    expect(fileObservation(after.files, CONSUMER).digest)
      .not.toBe(fileObservation(before.files, CONSUMER).digest);
    expect(fileObservation(after.files, CONSUMER).providerAddresses)
      .toEqual(expect.arrayContaining([
        "repo:src/augmentation.ts",
        "repo:src/provider.ts",
      ]));

    const inspected = inspectSemanticCompilerObservation(afterLoaded, CONSUMER);
    const use = bindingAt(inspected, consumer.lastIndexOf("Box"));
    expect(declarationAddresses(use.value.observed.aliased))
      .toEqual([
        "repo:src/provider.ts",
        "repo:src/augmentation.ts",
      ]);
  });

  it("records which conflicting star re-export wins when export order changes", () => {
    const common = {
      "src/consumer.ts": [
        'import { conflict } from "./barrel";',
        "export const selected = conflict;",
        "",
      ].join("\n"),
      "src/first.ts": 'export const conflict = "first";\n',
      "src/second.ts": 'export const conflict = "other";\n',
    };
    const firstThenSecond = loadedProject("/reexport/first", {
      ...common,
      "src/barrel.ts": [
        'export * from "./first";',
        'export * from "./second";',
        "",
      ].join("\n"),
    });
    const secondThenFirst = loadedProject("/reexport/second", {
      ...common,
      "src/barrel.ts": [
        'export * from "./second";',
        'export * from "./first";',
        "",
      ].join("\n"),
    });
    const firstObservation = fileObservation(
      collectSemanticCompilerObservations(firstThenSecond).files,
      CONSUMER,
    );
    const secondObservation = fileObservation(
      collectSemanticCompilerObservations(secondThenFirst).files,
      CONSUMER,
    );

    expect(secondObservation.digest).not.toBe(firstObservation.digest);
    expect(firstObservation.providerAddresses).toContain("repo:src/first.ts");
    expect(secondObservation.providerAddresses).toContain("repo:src/second.ts");
    // Boundary tracing is deliberately conservative: resolving a conflicting star export inspects
    // both declarations even though the checker binding transcript records which one wins.
    expect(firstObservation.providerAddresses).toEqual(expect.arrayContaining([
      "repo:src/barrel.ts",
      "repo:src/first.ts",
      "repo:src/second.ts",
    ]));
    expect(secondObservation.providerAddresses).toEqual(expect.arrayContaining([
      "repo:src/barrel.ts",
      "repo:src/first.ts",
      "repo:src/second.ts",
    ]));
  });

  it("binds every local barrel traversed to derive an external boundary identity", () => {
    const common = {
      "src/a.ts": 'export { Foo } from "./b";\n',
      "src/consumer.ts": [
        'import { Foo } from "./a";',
        "export const selected = Foo;",
        "",
      ].join("\n"),
      "types/shared.d.ts": "export declare class Foo {}\n",
    };
    const compilerOptions: ts.CompilerOptions = {
      baseUrl: "/reexport-boundary",
      paths: {
        "alias-one": ["types/shared.d.ts"],
        "alias-two": ["types/shared.d.ts"],
      },
    };
    const first = loadedProject("/reexport-boundary", {
      ...common,
      "src/b.ts": 'export { Foo } from "alias-one";\n',
    }, false, compilerOptions);
    const second = loadedProject("/reexport-boundary", {
      ...common,
      "src/b.ts": 'export { Foo } from "alias-two";\n',
    }, false, compilerOptions);

    expect(reexportBoundarySpecifier(first)).toBe("alias-one");
    expect(reexportBoundarySpecifier(second)).toBe("alias-two");

    // The final checker binding is deliberately the same shared declaration. Nevertheless b.ts is
    // a semantic input: resolveTarget recursively reads its written specifier to mint the external
    // graph identity. Omitting it lets the consumer region key collide across these two programs.
    expect(fileObservation(
      collectSemanticCompilerObservations(first).files,
      CONSUMER,
    ).providerAddresses).toContain("repo:src/b.ts");
    expect(fileObservation(
      collectSemanticCompilerObservations(second).files,
      CONSUMER,
    ).providerAddresses).toContain("repo:src/b.ts");
  });

  it.each([
    {
      name: "direct named binding",
      consumer: [
        'import { Foo } from "./a";',
        "export const selected = Foo;",
        "",
      ].join("\n"),
      firstBarrel: 'export { Foo } from "./b";\n',
      secondBarrel: 'export { Foo } from "external-boundary";\n',
      boundary: "export declare class Foo {}\n",
    },
    {
      name: "default binding",
      consumer: [
        'import Foo from "./a";',
        "export const selected = Foo;",
        "",
      ].join("\n"),
      firstBarrel: 'export { default } from "./b";\n',
      secondBarrel: 'export { default } from "external-boundary";\n',
      boundary: "export default class Foo {}\n",
    },
    {
      name: "namespace member",
      consumer: [
        'import * as sdk from "./a";',
        "export const selected = sdk.Foo;",
        "",
      ].join("\n"),
      firstBarrel: 'export * from "./b";\n',
      secondBarrel: 'export { Foo } from "external-boundary";\n',
      boundary: "export declare class Foo {}\n",
    },
    {
      name: "type-only binding",
      consumer: [
        'import type { Foo } from "./a";',
        "export type Selected = Foo;",
        "",
      ].join("\n"),
      firstBarrel: 'export { Foo } from "./b";\n',
      secondBarrel: 'export { Foo } from "external-boundary";\n',
      boundary: "export declare class Foo {}\n",
    },
    {
      name: "typed receiver",
      consumer: [
        'import type { Service } from "./a";',
        "declare const service: Service;",
        "export const selected = service.run();",
        "",
      ].join("\n"),
      firstBarrel: 'export { Service } from "./b";\n',
      secondBarrel: 'export { Service } from "external-boundary";\n',
      boundary: "export declare class Service { run(): void; }\n",
    },
    {
      name: "local export binding",
      consumer: [
        'import { Foo } from "./a";',
        "export { Foo };",
        "",
      ].join("\n"),
      firstBarrel: 'export { Foo } from "./b";\n',
      secondBarrel: 'export { Foo } from "external-boundary";\n',
      boundary: "export declare class Foo {}\n",
    },
    {
      name: "export-from binding",
      consumer: 'export { Foo } from "./a";\n',
      firstBarrel: 'export { Foo } from "./b";\n',
      secondBarrel: 'export { Foo } from "external-boundary";\n',
      boundary: "export declare class Foo {}\n",
    },
  ])("traces local barrels for a $name", ({
    boundary,
    consumer,
    firstBarrel,
    name,
    secondBarrel,
  }) => {
    const root = `/candidate-shapes/${name.replaceAll(" ", "-")}`;
    const loaded = loadedProject(root, {
      "src/a.ts": firstBarrel,
      "src/b.ts": secondBarrel,
      "src/consumer.ts": consumer,
      "types/shared.d.ts": boundary,
    }, false, {
      baseUrl: root,
      paths: {
        "external-boundary": ["types/shared.d.ts"],
      },
    });

    expect(fileObservation(
      collectSemanticCompilerObservations(loaded).files,
      CONSUMER,
    ).providerAddresses).toEqual(expect.arrayContaining([
      "repo:src/a.ts",
      "repo:src/b.ts",
    ]));
  });

  it("keeps the decision transcript stable for a provider body-only edit", () => {
    const consumer = [
      'import { decide } from "./provider";',
      "export const decision = decide();",
      "",
    ].join("\n");
    const before = collectSemanticCompilerObservations(
      loadedProject("/body/before", {
        "src/consumer.ts": consumer,
        "src/provider.ts": "export function decide(): number { return 1; }\n",
      }),
    );
    const after = collectSemanticCompilerObservations(
      loadedProject("/body/after", {
        "src/consumer.ts": consumer,
        "src/provider.ts": "export function decide(): number { return 2; }\n",
      }),
    );

    // The transcript proves compiler decisions, not source identity. Region addressing separately
    // includes the provider's exact program-input digest, so the provider and direct consumer are
    // still invalidated by this byte change even though symbol resolution is unchanged.
    expect(fileObservation(after.files, CONSUMER))
      .toEqual(fileObservation(before.files, CONSUMER));
    expect(fileObservation(after.files, "repo:src/provider.ts"))
      .toEqual(fileObservation(before.files, "repo:src/provider.ts"));
  });

  it("observes the constructed receiver member that recovers an any-typed call", () => {
    const consumer = [
      'import * as FrameworkModule from "./framework";',
      "export class DelegateClient {",
      "  private framework: any = null;",
      "  init(): void {",
      "    const { ChatFramework } = FrameworkModule;",
      "    this.framework = new ChatFramework();",
      "    this.framework.initialize();",
      "  }",
      "  destroy(): void { this.framework = null; }",
      "}",
      "",
    ].join("\n");
    const common = {
      "src/consumer.ts": consumer,
      "src/framework.ts": [
        'import { FrameworkBase } from "./base";',
        "export class ChatFramework extends FrameworkBase {}",
        "",
      ].join("\n"),
    };
    const before = loadedProject("/constructed-member/before", {
      ...common,
      "src/base.ts": "export class FrameworkBase {}\n",
    });
    const after = loadedProject("/constructed-member/after", {
      ...common,
      "src/base.ts": "export class FrameworkBase { initialize(): void {} }\n",
    });
    const beforeObservation = fileObservation(
      collectSemanticCompilerObservations(before).files,
      CONSUMER,
    );
    const afterObservation = fileObservation(
      collectSemanticCompilerObservations(after).files,
      CONSUMER,
    );

    expect(afterObservation.digest).not.toBe(beforeObservation.digest);
    expect(afterObservation.providerAddresses).toContain("repo:src/base.ts");
    const inspected = inspectSemanticCompilerObservation(after, CONSUMER);
    expect(inspected.transcript).toContainEqual(expect.objectContaining({
      kind: "constructed-receiver-member",
      value: expect.objectContaining({
        consensus: expect.objectContaining({
          declaration: expect.objectContaining({ address: "repo:src/base.ts" }),
        }),
      }),
    }));
  });

  it("is portable across absolute checkout roots, including quoted module symbols", () => {
    const files = {
      "src/consumer.ts": [
        'import { exportedValue } from "./provider";',
        "export const consumed = exportedValue;",
        "",
      ].join("\n"),
      "src/provider.ts": 'export const exportedValue = "stable";\n',
    };
    const first = loadedProject("/private/checkout-one", files);
    const second = loadedProject("/different/checkout-two", files);

    expect(collectSemanticCompilerObservations(second))
      .toEqual(collectSemanticCompilerObservations(first));
    expect(inspectSemanticCompilerObservation(second, CONSUMER))
      .toEqual(inspectSemanticCompilerObservation(first, CONSUMER));
    expect(JSON.stringify(inspectSemanticCompilerObservation(first, CONSUMER).transcript))
      .not.toContain("/private/checkout-one");
  });
});

interface BindingObservation {
  end: number;
  kind: "binding";
  start: number;
  value: {
    observed: {
      aliased: ObservedSymbol | null;
      direct: ObservedSymbol | null;
    };
  };
}

interface ObservedSymbol {
  declarations: Array<{ address: string }>;
}

function loadedProject(
  root: string,
  files: Readonly<Record<string, string>>,
  reverse = false,
  compilerOptions: ts.CompilerOptions = {},
): LoadedProject {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noLib: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      ...compilerOptions,
    },
  });
  const entries = Object.entries(files).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  if (reverse) entries.reverse();
  for (const [path, contents] of entries) {
    project.createSourceFile(`${root}/${path}`, contents);
  }
  const sourceFiles = project.getSourceFiles();
  return {
    project,
    sourceFiles,
    root,
    relativePathOf: (sourceFile: SourceFile) => (
      sourceFile.getFilePath().slice(root.length + 1)
    ),
  };
}

function reexportBoundarySpecifier(loaded: LoadedProject): string | null {
  const consumer = loaded.project.getSourceFileOrThrow("/reexport-boundary/src/consumer.ts");
  const use = consumer.getDescendantsOfKind(ts.SyntaxKind.Identifier).at(-1);
  if (use === undefined) throw new Error("consumer binding is missing");
  const imported = importedSymbolReference(use, use.getSymbol());
  if (imported === null) throw new Error("consumer import reference is missing");
  return throughLocalReexports(
    imported,
    new Set([
      "/reexport-boundary/src/a.ts",
      "/reexport-boundary/src/b.ts",
      "/reexport-boundary/src/consumer.ts",
    ]),
  )?.specifier ?? null;
}

function fileObservation(
  files: readonly SemanticCompilerFileObservation[],
  address: string,
): SemanticCompilerFileObservation {
  const observation = files.find((candidate) => candidate.address === address);
  if (observation === undefined) {
    throw new Error(`semantic compiler observation is missing ${address}`);
  }
  return observation;
}

function bindingAt(
  inspected: InspectedSemanticCompilerFileObservation,
  start: number,
): BindingObservation {
  const observation = inspected.transcript.find((candidate) => {
    if (candidate === null || typeof candidate !== "object") return false;
    const value = candidate as Partial<BindingObservation>;
    return value.kind === "binding" && value.start === start;
  });
  if (observation === undefined) {
    throw new Error(`binding observation is missing at source offset ${start}`);
  }
  return observation as BindingObservation;
}

function declarationAddresses(symbol: ObservedSymbol | null): string[] {
  return symbol?.declarations.map((declaration) => declaration.address) ?? [];
}
