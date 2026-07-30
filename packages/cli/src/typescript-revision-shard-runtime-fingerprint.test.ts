import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeTypeScriptRevisionShardBuildFingerprint,
  typeScriptRevisionShardRuntimeFingerprint,
} from "./typescript-revision-shard-runtime-fingerprint";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("TypeScript revision-shard runtime fingerprint", () => {
  it("excludes unrelated CLI, renderer, and Python bytes from the executable closure", () => {
    const fixture = runtimeFixture();
    const first = fixture.fingerprint();

    writeFileSync(join(fixture.root, "packages", "cli", "dist", "web.js"), "web-v2\n");
    writeFileSync(
      join(fixture.root, "packages", "renderer", "dist", "index.js"),
      "renderer-v2\n",
    );
    writeFileSync(
      join(fixture.root, "packages", "extractor-python", "python", "extract.py"),
      "print('python-v2')\n",
    );
    writeFileSync(join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: changed\n");

    expect(fixture.fingerprint()).toBe(first);
  });

  it.each([
    ["extractor entry", "packages/extractor-typescript/dist/index.js"],
    ["core runtime", "packages/core/dist/index.js"],
    ["core schema", "packages/core/schema/graph.schema.json"],
    ["TypeScript toolchain", "packages/ts-morph/dist/index.js"],
  ])("invalidates when the %s changes", (_label, relativePath) => {
    const fixture = runtimeFixture();
    const first = fixture.fingerprint();

    writeFileSync(join(fixture.root, relativePath), `changed:${relativePath}\n`);

    expect(fixture.fingerprint()).not.toBe(first);
  });

  it("invalidates when the extractor manifest changes", () => {
    const fixture = runtimeFixture();
    const first = fixture.fingerprint();
    writeFileSync(
      join(fixture.root, "packages/extractor-typescript/package.json"),
      JSON.stringify({
        name: "@meridian/extractor-typescript",
        version: "0.2.0",
        dependencies: {
          "@meridian/core": "workspace:*",
          "ts-morph": "28.0.0",
        },
      }),
    );

    expect(fixture.fingerprint()).not.toBe(first);
  });

  it("invalidates when dependency resolution selects a different installed package", () => {
    const fixture = runtimeFixture();
    const first = fixture.fingerprint();
    const replacement = packageFixture(
      fixture.root,
      "packages/core-replacement",
      "@meridian/core",
      "core-replacement\n",
    );
    fixture.dependencies.set("@meridian/core", replacement.manifest);

    expect(fixture.fingerprint()).not.toBe(first);
  });

  it("reports the exact current executable and runtime coordinates", () => {
    const first = typeScriptRevisionShardRuntimeFingerprint();

    expect(typeScriptRevisionShardRuntimeFingerprint()).toBe(first);
    expect(first).toEqual({
      buildFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      typescriptVersion: expect.any(String),
      tsMorphVersion: expect.any(String),
    });
  });
});

function runtimeFixture(): {
  root: string;
  dependencies: Map<string, string>;
  fingerprint(): string;
} {
  const root = mkdtempSync(join(tmpdir(), "meridian-typescript-shard-runtime-"));
  temporaryRoots.push(root);
  writeFile(root, "pnpm-lock.yaml", "lockfileVersion: 9\n");

  const extractor = packageFixture(
    root,
    "packages/extractor-typescript",
    "@meridian/extractor-typescript",
    "extractor-v1\n",
    {
      "@meridian/core": "workspace:*",
      "ts-morph": "28.0.0",
    },
  );
  writeFile(root, "packages/extractor-typescript/tsup.config.ts", "build-v1\n");
  const core = packageFixture(
    root,
    "packages/core",
    "@meridian/core",
    "core-v1\n",
  );
  writeFile(root, "packages/core/schema/graph.schema.json", "{\"version\":1}\n");
  const tsMorph = packageFixture(
    root,
    "packages/ts-morph",
    "ts-morph",
    "ts-morph-v1\n",
  );
  packageFixture(root, "packages/cli", "@meridian/cli", "cli-v1\n");
  packageFixture(root, "packages/renderer", "@meridian/renderer", "renderer-v1\n");
  const pythonRoot = join(root, "packages", "extractor-python");
  writeFile(root, "packages/extractor-python/package.json", JSON.stringify({
    name: "@meridian/extractor-python",
    version: "0.1.0",
  }));
  mkdirSync(join(pythonRoot, "python"), { recursive: true });
  writeFileSync(join(pythonRoot, "python", "extract.py"), "print('python-v1')\n");

  const dependencies = new Map([
    ["@meridian/core", core.manifest],
    ["ts-morph", tsMorph.manifest],
  ]);
  return {
    root,
    dependencies,
    fingerprint: () => computeTypeScriptRevisionShardBuildFingerprint({
      extractorPackageManifest: extractor.manifest,
      extractorEntry: extractor.entry,
      resolveDependencyManifest: (name) => dependencies.get(name),
    }),
  };
}

function packageFixture(
  root: string,
  relativeRoot: string,
  name: string,
  entryBytes: string,
  dependencies: Record<string, string> = {},
): { manifest: string; entry: string } {
  const packageRoot = join(root, relativeRoot);
  const manifest = join(packageRoot, "package.json");
  const entry = join(packageRoot, "dist", "index.js");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(manifest, JSON.stringify({
    name,
    version: "0.1.0",
    dependencies,
  }));
  writeFileSync(entry, entryBytes);
  return { manifest, entry };
}

function writeFile(root: string, relativePath: string, bytes: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
