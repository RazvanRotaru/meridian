import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitBlobIdentity } from "./model";
import { typeScriptConfigInputs } from "./config-inputs";

describe("typeScriptConfigInputs", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-config-inputs-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("records absent unit and root selection probes without inventing a config", () => {
    const result = typeScriptConfigInputs(root, "packages/app", []);

    expect(result).toEqual({
      selectedConfigAddress: null,
      selectionProbes: [
        {
          role: "unit",
          address: "repo:packages/app/tsconfig.json",
          exists: false,
          state: "absent",
        },
        {
          role: "root",
          address: "repo:tsconfig.json",
          exists: false,
          state: "absent",
        },
      ],
      configFiles: [],
      extendsInputs: [],
      reuseEligibility: { eligible: true, reasons: [] },
    });
  });

  it("selects the tracked root config when the unit probe is absent", () => {
    write("tsconfig.json", '{"compilerOptions":{"strict":true}}\n');
    const result = typeScriptConfigInputs(root, "packages/app", tracked("tsconfig.json"));

    expect(result.selectedConfigAddress).toBe("repo:tsconfig.json");
    expect(result.selectionProbes.map(({ role, state }) => ({ role, state }))).toEqual([
      { role: "unit", state: "absent" },
      { role: "root", state: "file" },
    ]);
    expect(result.configFiles).toHaveLength(1);
    expect(result.configFiles[0]).toMatchObject({
      address: "repo:tsconfig.json",
      trackedBlobOid: tracked("tsconfig.json")[0]!.oid,
      trackedMode: "100644",
    });
    expect(result.configFiles[0]!.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.reuseEligibility).toEqual({ eligible: true, reasons: [] });
  });

  it("selects a unit config and does not hash bytes from the unchosen root config", () => {
    write("tsconfig.json", '{"compilerOptions":{"strict":false}}\n');
    write("packages/app/tsconfig.json", '{"compilerOptions":{"strict":true}}\n');
    const blobs = tracked("tsconfig.json", "packages/app/tsconfig.json");
    const first = typeScriptConfigInputs(root, "packages/app", blobs);

    write("tsconfig.json", '{"compilerOptions":{"strict":false},"display":"changed"}\n');
    const second = typeScriptConfigInputs(
      root,
      "packages/app",
      tracked("tsconfig.json", "packages/app/tsconfig.json"),
    );

    expect(first.selectedConfigAddress).toBe("repo:packages/app/tsconfig.json");
    expect(first.configFiles.map((input) => input.address)).toEqual([
      "repo:packages/app/tsconfig.json",
    ]);
    expect(second.configFiles).toEqual(first.configFiles);
    expect(second.selectionProbes).toEqual(first.selectionProbes);
  });

  it("records every tracked local extends input with TypeScript JSON syntax", () => {
    write(
      "tsconfig.json",
      [
        "{",
        '  // TypeScript accepts comments and trailing commas.',
        '  "extends": ["./configs/base", "./configs/strict.json",],',
        "}",
        "",
      ].join("\n"),
    );
    write("configs/base.json", '{"extends":"./shared","compilerOptions":{"target":"ES2022"}}\n');
    write("configs/shared.json", '{"compilerOptions":{"module":"ESNext"}}\n');
    write("configs/strict.json", '{"compilerOptions":{"strict":true}}\n');
    const paths = [
      "tsconfig.json",
      "configs/base.json",
      "configs/shared.json",
      "configs/strict.json",
    ];

    const result = typeScriptConfigInputs(root, "packages/app", tracked(...paths));

    expect(result.configFiles.map((input) => input.address)).toEqual([
      "repo:configs/base.json",
      "repo:configs/shared.json",
      "repo:configs/strict.json",
      "repo:tsconfig.json",
    ]);
    expect(result.extendsInputs).toEqual(expect.arrayContaining([
      {
        from: "repo:tsconfig.json",
        index: 0,
        specifier: "./configs/base",
        resolvedAddress: "repo:configs/base.json",
      },
      {
        from: "repo:tsconfig.json",
        index: 1,
        specifier: "./configs/strict.json",
        resolvedAddress: "repo:configs/strict.json",
      },
      {
        from: "repo:configs/base.json",
        index: 0,
        specifier: "./shared",
        resolvedAddress: "repo:configs/shared.json",
      },
    ]));
    expect(result.reuseEligibility).toEqual({ eligible: true, reasons: [] });
    expect(typeScriptConfigInputs(root, "packages/app", tracked(...paths))).toEqual(result);
  });

  it("binds extensionless-before-json local extends priority", () => {
    write("tsconfig.json", '{"extends":"./configs/base"}\n');
    write("configs/base.json", '{"compilerOptions":{"strict":true}}\n');
    const treeBlobs = tracked("tsconfig.json", "configs/base.json");

    const jsonOnly = typeScriptConfigInputs(root, "packages/app", treeBlobs);
    expect(jsonOnly.extendsInputs).toEqual([{
      from: "repo:tsconfig.json",
      index: 0,
      specifier: "./configs/base",
      resolvedAddress: "repo:configs/base.json",
    }]);
    expect(jsonOnly.reuseEligibility).toEqual({ eligible: true, reasons: [] });

    write("configs/base", '{"compilerOptions":{"strict":false}}\n');
    const extensionlessPresent = typeScriptConfigInputs(root, "packages/app", treeBlobs);
    expect(extensionlessPresent.extendsInputs).toEqual([{
      from: "repo:tsconfig.json",
      index: 0,
      specifier: "./configs/base",
      resolvedAddress: "repo:configs/base",
    }]);
    expect(extensionlessPresent.configFiles.map((input) => input.address)).toEqual([
      "repo:configs/base",
      "repo:tsconfig.json",
    ]);
    expect(extensionlessPresent.reuseEligibility).toEqual({
      eligible: false,
      reasons: ["untracked-config-input"],
    });
    expect(extensionlessPresent).not.toEqual(jsonOnly);
  });

  it("marks an untracked selected config ineligible while retaining its digest", () => {
    write("tsconfig.json", '{"compilerOptions":{"strict":true}}\n');

    const result = typeScriptConfigInputs(root, "packages/app", []);

    expect(result.configFiles[0]).toMatchObject({
      address: "repo:tsconfig.json",
      trackedBlobOid: null,
    });
    expect(result.reuseEligibility).toEqual({
      eligible: false,
      reasons: ["untracked-config-input"],
    });
  });

  it("marks a selected config symlink ineligible without following it", () => {
    write("configs/base.json", '{"compilerOptions":{"strict":true}}\n');
    symlinkSync("configs/base.json", join(root, "tsconfig.json"));

    const result = typeScriptConfigInputs(root, "packages/app", tracked("configs/base.json"));

    expect(result.selectedConfigAddress).toBe("repo:tsconfig.json");
    expect(result.selectionProbes[1]).toMatchObject({
      exists: true,
      state: "symlink",
    });
    expect(result.configFiles).toEqual([]);
    expect(result.reuseEligibility).toEqual({
      eligible: false,
      reasons: ["unsupported-config-symlink"],
    });
  });

  it("marks malformed and invalid extends configs ineligible", () => {
    write("tsconfig.json", "{ definitely not config\n");
    const malformed = typeScriptConfigInputs(root, "", tracked("tsconfig.json"));
    expect(malformed.reuseEligibility).toEqual({
      eligible: false,
      reasons: ["malformed-config-input"],
    });

    write("tsconfig.json", '{"extends":[42]}\n');
    const invalidExtends = typeScriptConfigInputs(root, "", tracked("tsconfig.json"));
    expect(invalidExtends.reuseEligibility).toEqual({
      eligible: false,
      reasons: ["invalid-config-extends"],
    });
  });

  it("marks unresolved, package, and escaping extends paths ineligible", () => {
    write(
      "tsconfig.json",
      '{"extends":["./missing","@fixture/tsconfig","../outside.json"]}\n',
    );
    const result = typeScriptConfigInputs(root, "", tracked("tsconfig.json"));

    expect(result.extendsInputs).toEqual([
      {
        from: "repo:tsconfig.json",
        index: 0,
        specifier: "./missing",
        resolvedAddress: null,
      },
      {
        from: "repo:tsconfig.json",
        index: 1,
        specifier: "@fixture/tsconfig",
        resolvedAddress: null,
      },
      {
        from: "repo:tsconfig.json",
        index: 2,
        specifier: "../outside.json",
        resolvedAddress: null,
      },
    ]);
    expect(result.reuseEligibility).toEqual({
      eligible: false,
      reasons: [
        "external-config-extends",
        "unresolved-config-extends",
        "unsupported-package-config-extends",
      ],
    });
  });

  it("marks a local extends cycle ineligible", () => {
    write("tsconfig.json", '{"extends":"./config/base.json"}\n');
    write("config/base.json", '{"extends":"../tsconfig.json"}\n');

    const result = typeScriptConfigInputs(
      root,
      "",
      tracked("tsconfig.json", "config/base.json"),
    );

    expect(result.configFiles.map((input) => input.address)).toEqual([
      "repo:config/base.json",
      "repo:tsconfig.json",
    ]);
    expect(result.reuseEligibility).toEqual({
      eligible: false,
      reasons: ["cyclic-config-extends"],
    });
  });

  it("rejects tracked identities whose bytes do not match the checkout", () => {
    write("tsconfig.json", '{"compilerOptions":{"strict":true}}\n');
    const blobs = tracked("tsconfig.json");
    write("tsconfig.json", '{"compilerOptions":{"strict":false}}\n');

    expect(() => typeScriptConfigInputs(root, "", blobs)).toThrow(
      /config bytes differ from Git tree/,
    );
  });

  function write(path: string, contents: string): void {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  function tracked(...paths: string[]): GitBlobIdentity[] {
    return paths.map((path) => {
      const bytes = readFileSync(join(root, path));
      return {
        path,
        oid: createHash("sha1")
          .update(`blob ${bytes.byteLength}\0`)
          .update(bytes)
          .digest("hex"),
        mode: "100644",
        byteSize: bytes.byteLength,
      };
    });
  }
});
