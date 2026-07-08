/**
 * The change-status parser + URL codec: bare paths default to "modified", git name-status codes
 * (incl. a rename's NEW path) map to our vocabulary, and the `files` param round-trips with the
 * no-prefix=modified back-compat that keeps legacy `?files=a,b` links working.
 */

import { describe, expect, it } from "vitest";
import { encodeFilesParam, parseAffectedInput, parseFilesParam } from "./changeStatus";

describe("parseAffectedInput", () => {
  it("defaults bare paths to modified and normalizes them", () => {
    const { paths, statusByFile } = parseAffectedInput("src/a.ts\n./src/b.ts\n");
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(statusByFile).toEqual({ "src/a.ts": "modified", "src/b.ts": "modified" });
  });

  it("parses git name-status codes incl. digits and a rename's new path", () => {
    const text = ["A\tsrc/new.ts", "M\tsrc/mod.ts", "D\tsrc/gone.ts", "R100\tsrc/old.ts\tsrc/renamed.ts"].join("\n");
    const { paths, statusByFile } = parseAffectedInput(text);
    expect(paths).toEqual(["src/new.ts", "src/mod.ts", "src/gone.ts", "src/renamed.ts"]);
    expect(statusByFile).toEqual({
      "src/new.ts": "added",
      "src/mod.ts": "modified",
      "src/gone.ts": "removed",
      "src/renamed.ts": "renamed",
    });
  });

  it("ignores blank lines and normalizes backslashes", () => {
    const { paths } = parseAffectedInput("\n   \nsrc\\win\\path.ts\n");
    expect(paths).toEqual(["src/win/path.ts"]);
  });

  it("treats a path that merely starts with a code letter as a plain path", () => {
    const { paths, statusByFile } = parseAffectedInput("App/Main.ts\nModels/User.ts");
    expect(paths).toEqual(["App/Main.ts", "Models/User.ts"]);
    expect(statusByFile).toEqual({ "App/Main.ts": "modified", "Models/User.ts": "modified" });
  });
});

describe("files URL param codec", () => {
  it("round-trips paths + status, prefixing only the non-modified ones", () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    const statusByFile: Record<string, "added" | "removed" | "renamed"> = {
      "src/a.ts": "added",
      "src/c.ts": "removed",
      "src/d.ts": "renamed",
    };
    const encoded = encodeFilesParam(paths, statusByFile);
    expect(encoded).toBe("a:src/a.ts,src/b.ts,d:src/c.ts,r:src/d.ts");
    const parsed = parseFilesParam(encoded);
    expect(parsed.paths).toEqual(paths);
    expect(parsed.statusByFile).toEqual(statusByFile);
  });

  it("decodes a legacy prefixless param as all-modified (empty status map)", () => {
    const parsed = parseFilesParam("src/a.ts,src/b.ts");
    expect(parsed.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parsed.statusByFile).toEqual({});
  });

  it("encodes an all-modified list byte-identically to a plain comma join (back-compat)", () => {
    expect(encodeFilesParam(["src/a.ts", "src/b.ts"], {})).toBe("src/a.ts,src/b.ts");
  });
});
