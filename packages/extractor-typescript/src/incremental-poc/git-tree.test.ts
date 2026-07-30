import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listGitTreeBlobs,
  revalidateAdmittedUnitInputsAtExactTree,
  verifyCleanCheckoutAtTree,
  verifyGitTreeInputs,
} from "./git-tree";
import {
  resolutionLookupInputKey,
  resolutionLookupProofKey,
} from "./fingerprints";
import { sha256Hex } from "./canonical-json";
import {
  POC_SHARD_VERSION,
  type UnitInputFingerprint,
} from "./model";

let root: string;
let treeOid: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function commit(message: string): void {
  git("add", "--all");
  git("commit", "-q", "-m", message);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "meridian-git-tree-"));
  git("init", "-q");
  git("config", "user.name", "Meridian Test");
  git("config", "user.email", "meridian@example.test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "odd\tname.ts"), "x\n");
  commit("initial");
  treeOid = git("rev-parse", "HEAD^{tree}");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listGitTreeBlobs", () => {
  it("returns exact NUL-safe paths, object IDs, modes, and sizes", async () => {
    const entries = await listGitTreeBlobs(root, treeOid);

    expect(entries.map((entry) => entry.path)).toEqual(["odd\tname.ts", "src/index.ts"]);
    expect(entries.every((entry) => /^[0-9a-f]{40,64}$/.test(entry.oid))).toBe(true);
    expect(entries.map((entry) => entry.mode)).toEqual(["100644", "100644"]);
    expect(entries.map((entry) => entry.byteSize)).toEqual([2, 24]);
  });

  it("requires a full object ID", async () => {
    await expect(listGitTreeBlobs(root, treeOid.slice(0, 12))).rejects.toThrow(/exact/);
  });

  it("fails closed instead of omitting a gitlink", async () => {
    const commitOid = git("rev-parse", "HEAD");
    git("update-index", "--add", "--cacheinfo", `160000,${commitOid},vendor/submodule`);
    git("commit", "-q", "-m", "gitlink");
    const gitlinkTree = git("rev-parse", "HEAD^{tree}");

    await expect(listGitTreeBlobs(root, gitlinkTree)).rejects.toThrow(/Git commit entry/);
  });

  it("fingerprints a materialized tracked symlink to a tracked regular blob", async () => {
    writeFileSync(join(root, "src", "CLAUDE.md"), "rules\n");
    symlinkSync("CLAUDE.md", join(root, "src", "AGENTS.md"));
    commit("tracked link");
    const entries = await listGitTreeBlobs(root, git("rev-parse", "HEAD^{tree}"));

    const verified = await verifyGitTreeInputs(root, entries);

    expect(verified.regularBlobs.map((entry) => entry.path)).toEqual([
      "odd\tname.ts",
      "src/CLAUDE.md",
      "src/index.ts",
    ]);
    expect(verified.symlinks).toEqual([
      expect.objectContaining({
        path: "src/AGENTS.md",
        target: "CLAUDE.md",
        resolvedPath: "src/CLAUDE.md",
        resolvedMode: "100644",
      }),
    ]);
    expect(verified.symlinks[0]?.linkBlobOid).toMatch(/^[0-9a-f]{40,64}$/);
    expect(verified.symlinks[0]?.resolvedBlobOid).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("fails closed for escaping, dangling, or chained tracked symlinks", async () => {
    symlinkSync("../../outside", join(root, "src", "escape"));
    commit("escaping link");
    await expect(
      verifyGitTreeInputs(root, await listGitTreeBlobs(root, git("rev-parse", "HEAD^{tree}"))),
    ).rejects.toThrow(/escapes the repository/);

    unlinkSync(join(root, "src", "escape"));
    symlinkSync("missing", join(root, "src", "dangling"));
    commit("dangling link");
    await expect(
      verifyGitTreeInputs(root, await listGitTreeBlobs(root, git("rev-parse", "HEAD^{tree}"))),
    ).rejects.toThrow(/target is not in the exact Git tree/);

    unlinkSync(join(root, "src", "dangling"));
    symlinkSync("index.ts", join(root, "src", "first"));
    symlinkSync("first", join(root, "src", "second"));
    commit("chained link");
    await expect(
      verifyGitTreeInputs(root, await listGitTreeBlobs(root, git("rev-parse", "HEAD^{tree}"))),
    ).rejects.toThrow(/target is not a regular Git blob/);
  }, 15_000);
});

describe("verifyCleanCheckoutAtTree", () => {
  it("binds a clean checkout to its exact HEAD tree", async () => {
    const verified = await verifyCleanCheckoutAtTree(root, treeOid);

    expect(verified.expectedTreeOid).toBe(treeOid);
    expect(verified.headTreeOid).toBe(treeOid);
    expect(verified.headCommitOid).toBe(git("rev-parse", "HEAD"));
  });

  it("rejects tracked or untracked checkout changes", async () => {
    writeFileSync(join(root, "untracked.ts"), "export {};\n");
    await expect(verifyCleanCheckoutAtTree(root, treeOid)).rejects.toThrow(/not clean/);
  });

  it("rejects a clean HEAD at a different tree", async () => {
    writeFileSync(join(root, "src", "index.ts"), "export const value = 2;\n");
    commit("second");

    await expect(verifyCleanCheckoutAtTree(root, treeOid)).rejects.toThrow(/does not match/);
  });
});

describe("revalidateAdmittedUnitInputsAtExactTree", () => {
  it("rejects an ignored extensionless config that takes priority over admitted .json extends", async () => {
    writeFileSync(join(root, ".gitignore"), "/configs/base\n");
    mkdirSync(join(root, "configs"));
    writeFileSync(join(root, "tsconfig.json"), '{"extends":"./configs/base"}\n');
    writeFileSync(
      join(root, "configs", "base.json"),
      '{"compilerOptions":{"strict":true}}\n',
    );
    commit("add tracked local config extends");
    treeOid = git("rev-parse", "HEAD^{tree}");
    const treeBlobs = (await verifyGitTreeInputs(
      root,
      await listGitTreeBlobs(root, treeOid),
    )).regularBlobs;
    const inputs = exactTreeUnitFingerprint(
      treeBlobs,
      "export const value = 1;\n",
    );
    inputs.typescriptConfig = {
      selectedConfigAddress: "repo:tsconfig.json",
      selectionProbes: [
        {
          role: "unit",
          address: "repo:src/tsconfig.json",
          exists: false,
          state: "absent",
        },
        {
          role: "root",
          address: "repo:tsconfig.json",
          exists: true,
          state: "file",
        },
      ],
      configFiles: [
        trackedConfigInput(root, treeBlobs, "configs/base.json"),
        trackedConfigInput(root, treeBlobs, "tsconfig.json"),
      ],
      extendsInputs: [{
        from: "repo:tsconfig.json",
        index: 0,
        specifier: "./configs/base",
        resolvedAddress: "repo:configs/base.json",
      }],
      reuseEligibility: { eligible: true, reasons: [] },
    };

    expect(revalidateAdmittedUnitInputsAtExactTree(root, inputs, treeBlobs)).toBe(true);

    writeFileSync(
      join(root, "configs", "base"),
      '{"compilerOptions":{"strict":false}}\n',
    );
    expect(git("status", "--porcelain")).toBe("");
    expect(revalidateAdmittedUnitInputsAtExactTree(root, inputs, treeBlobs)).toBe(false);
  });

  it("verifies owned triple-slash evidence and rejects an ignored target that appears", async () => {
    const sourceText = [
      '/// <reference path="../generated/triple-types.d.ts" />',
      "export const value = 1;",
      "",
    ].join("\n");
    writeFileSync(join(root, "src", "index.ts"), sourceText);
    writeFileSync(join(root, ".gitignore"), "/generated/\n");
    commit("add absent owned triple-slash input");
    treeOid = git("rev-parse", "HEAD^{tree}");
    const treeBlobs = (await verifyGitTreeInputs(
      root,
      await listGitTreeBlobs(root, treeOid),
    )).regularBlobs;
    const inputs = exactTreeUnitFingerprint(treeBlobs, sourceText);

    expect(revalidateAdmittedUnitInputsAtExactTree(root, inputs, treeBlobs)).toBe(true);

    mkdirSync(join(root, "generated"));
    writeFileSync(
      join(root, "generated", "triple-types.d.ts"),
      "declare interface AppearedIgnoredType { value: string }\n",
    );
    expect(git("status", "--porcelain")).toBe("");
    expect(revalidateAdmittedUnitInputsAtExactTree(root, inputs, treeBlobs)).toBe(false);
  });

  it("fails closed for dangling, malformed, and orphan lookup proof data", async () => {
    const sourceText = [
      '/// <reference path="../generated/triple-types.d.ts" />',
      "export const value = 1;",
      "",
    ].join("\n");
    writeFileSync(join(root, "src", "index.ts"), sourceText);
    commit("add owned triple-slash input");
    treeOid = git("rev-parse", "HEAD^{tree}");
    const treeBlobs = (await verifyGitTreeInputs(
      root,
      await listGitTreeBlobs(root, treeOid),
    )).regularBlobs;
    const inputs = exactTreeUnitFingerprint(treeBlobs, sourceText);
    expect(revalidateAdmittedUnitInputsAtExactTree(root, inputs, treeBlobs)).toBe(true);

    const dangling = structuredClone(inputs);
    dangling.programInputs[0]!.resolutionLookupProofKey = "0".repeat(64);
    expect(revalidateAdmittedUnitInputsAtExactTree(root, dangling, treeBlobs)).toBe(false);

    const malformed = structuredClone(inputs);
    const inputKey = malformed.resolutionLookupProofs[0]!.resolutionLookupInputKeys[0]!;
    const malformedProof = { resolutionLookupInputKeys: [inputKey, inputKey] };
    malformed.resolutionLookupProofs = [malformedProof];
    malformed.programInputs[0]!.resolutionLookupProofKey =
      resolutionLookupProofKey(malformedProof);
    expect(revalidateAdmittedUnitInputsAtExactTree(root, malformed, treeBlobs)).toBe(false);

    const orphanProof = structuredClone(inputs);
    orphanProof.resolutionLookupProofs.push({ resolutionLookupInputKeys: [] });
    expect(revalidateAdmittedUnitInputsAtExactTree(root, orphanProof, treeBlobs)).toBe(false);

    const orphanInput = structuredClone(inputs);
    orphanInput.resolutionLookupInputs.push({
      address: "repo:generated/orphan.d.ts",
      purpose: "affecting",
      state: "absent",
      digest: null,
      trackedBlobOid: null,
    });
    expect(revalidateAdmittedUnitInputsAtExactTree(root, orphanInput, treeBlobs)).toBe(false);
  });
});

function exactTreeUnitFingerprint(
  treeBlobs: Awaited<ReturnType<typeof listGitTreeBlobs>>,
  sourceText: string,
): UnitInputFingerprint {
  const source = treeBlobs.find((blob) => blob.path === "src/index.ts");
  if (source === undefined) throw new Error("source blob is missing");
  const lookupInput: UnitInputFingerprint["resolutionLookupInputs"][number] = {
    address: "repo:generated/triple-types.d.ts",
    purpose: "affecting",
    state: "absent",
    digest: null,
    trackedBlobOid: null,
  };
  const proof = {
    resolutionLookupInputKeys: [resolutionLookupInputKey(lookupInput)],
  };
  return {
    version: POC_SHARD_VERSION,
    unit: {
      dir: "src",
      name: null,
      entryFile: null,
      sourceDir: "src",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [],
    },
    sourceBlobs: [{ ...source }],
    typescriptConfig: {
      selectedConfigAddress: null,
      selectionProbes: [],
      configFiles: [],
      extendsInputs: [],
      reuseEligibility: { eligible: true, reasons: [] },
    },
    programInputs: [{
      address: "repo:src/index.ts",
      digest: sha256Hex(sourceText),
      kind: "unit-source",
      filesystemInputKeys: [],
      resolutionLookupProofKey: resolutionLookupProofKey(proof),
      impliedNodeFormat: null,
      isDefaultLibrary: false,
      isExternalLibrary: false,
      trackedBlobOid: source.oid,
    }],
    filesystemInputs: [],
    moduleResolutions: [],
    typeReferenceResolutions: [],
    resolutionLookupProofs: [proof],
    resolutionLookupInputs: [lookupInput],
    unattributedResolutionLookupInputKeys: [],
    structuralMemberBoundaries: null,
    reuseEligibility: { eligible: true, reasons: [] },
    compilerOptionsDigest: "test-compiler-options",
    policy: {
      depth: "function",
      exclude: [],
      includeExternal: false,
      includeUnresolved: false,
      emitImportEdges: true,
      valueRefs: false,
    },
    provenance: {
      extractorVersion: "test",
      analysisPolicyVersion: "test",
      schemaVersion: "test",
      shardSchemaVersion: POC_SHARD_VERSION,
      tsMorphVersion: "test",
      typescriptVersion: "test",
    },
  };
}

function trackedConfigInput(
  repoRoot: string,
  treeBlobs: Awaited<ReturnType<typeof listGitTreeBlobs>>,
  path: string,
): UnitInputFingerprint["typescriptConfig"]["configFiles"][number] {
  const blob = treeBlobs.find((candidate) => candidate.path === path);
  if (blob === undefined) throw new Error(`config blob is missing: ${path}`);
  const bytes = readFileSync(join(repoRoot, ...path.split("/")));
  return {
    address: `repo:${path}`,
    digest: sha256Hex(bytes),
    byteSize: bytes.byteLength,
    trackedBlobOid: blob.oid,
    trackedMode: blob.mode,
  };
}
