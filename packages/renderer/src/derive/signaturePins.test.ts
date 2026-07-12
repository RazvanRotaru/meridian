import { describe, expect, test } from "vitest";
import { parseSignature, categorizeType, buildPinModel, MAX_INPUT_PINS } from "./signaturePins";

describe("parseSignature", () => {
  test("a no-arg, no-return signature has no params and no return type", () => {
    expect(parseSignature("noop()")).toEqual({ params: [], returnType: null });
  });

  test("a single typed param and a return type", () => {
    expect(parseSignature("greet(name: string): void")).toEqual({
      params: [{ name: "name", type: "string", optional: false, rest: false }],
      returnType: "void",
    });
  });

  test("multiple typed params split on top-level commas", () => {
    expect(parseSignature("add(a: number, b: number): number")).toEqual({
      params: [
        { name: "a", type: "number", optional: false, rest: false },
        { name: "b", type: "number", optional: false, rest: false },
      ],
      returnType: "number",
    });
  });

  test("an un-annotated param keeps a null type", () => {
    expect(parseSignature("handler(evt)")).toEqual({
      params: [{ name: "evt", type: null, optional: false, rest: false }],
      returnType: null,
    });
  });

  test("an optional param is flagged and the `?` is stripped from the name", () => {
    expect(parseSignature("f(x?: number)")).toEqual({
      params: [{ name: "x", type: "number", optional: true, rest: false }],
      returnType: null,
    });
  });

  test("a rest param is flagged and the `...` is stripped from the name", () => {
    expect(parseSignature("log(...args: string[])")).toEqual({
      params: [{ name: "args", type: "string[]", optional: false, rest: true }],
      returnType: null,
    });
  });

  test("a comma inside a generic type does NOT split the param", () => {
    expect(parseSignature("index(m: Map<string, number>): void")).toEqual({
      params: [{ name: "m", type: "Map<string, number>", optional: false, rest: false }],
      returnType: "void",
    });
  });

  test("a comma inside a function-type param does NOT split the param", () => {
    expect(parseSignature("on(cb: (a: number, b: number) => void)")).toEqual({
      params: [{ name: "cb", type: "(a: number, b: number) => void", optional: false, rest: false }],
      returnType: null,
    });
  });

  test("a comma inside an object-type param does NOT split the param", () => {
    expect(parseSignature("save(opts: { retries: number, force: boolean })")).toEqual({
      params: [{ name: "opts", type: "{ retries: number, force: boolean }", optional: false, rest: false }],
      returnType: null,
    });
  });

  test("a generic return type is captured whole", () => {
    expect(parseSignature("fetchUser(id: string): Promise<User>")).toEqual({
      params: [{ name: "id", type: "string", optional: false, rest: false }],
      returnType: "Promise<User>",
    });
  });

  test("text with no parameter list is unparseable", () => {
    expect(parseSignature("")).toBeNull();
    expect(parseSignature("justAName")).toBeNull();
  });
});

describe("categorizeType", () => {
  test("booleans and boolean literals", () => {
    expect(categorizeType("boolean")).toBe("bool");
    expect(categorizeType("true")).toBe("bool");
    expect(categorizeType("false")).toBe("bool");
  });

  test("numbers, bigints and numeric literals", () => {
    expect(categorizeType("number")).toBe("number");
    expect(categorizeType("bigint")).toBe("number");
    expect(categorizeType("42")).toBe("number");
  });

  test("strings and string literals", () => {
    expect(categorizeType("string")).toBe("string");
    expect(categorizeType('"active"')).toBe("string");
  });

  test("void-like types read as void", () => {
    expect(categorizeType("void")).toBe("void");
    expect(categorizeType("undefined")).toBe("void");
    expect(categorizeType("null")).toBe("void");
    expect(categorizeType("never")).toBe("void");
  });

  test("any / unknown read as any", () => {
    expect(categorizeType("any")).toBe("any");
    expect(categorizeType("unknown")).toBe("any");
  });

  test("an un-annotated (null) type reads as any", () => {
    expect(categorizeType(null)).toBe("any");
  });

  test("named types and object literals read as object", () => {
    expect(categorizeType("User")).toBe("object");
    expect(categorizeType("{ id: string }")).toBe("object");
    expect(categorizeType("Foo.Bar")).toBe("object");
  });

  test("a function type reads as function", () => {
    expect(categorizeType("(a: number) => void")).toBe("function");
    expect(categorizeType("() => User")).toBe("function");
  });

  test("array types read as array regardless of element type", () => {
    expect(categorizeType("string[]")).toBe("array");
    expect(categorizeType("Array<number>")).toBe("array");
    expect(categorizeType("ReadonlyArray<User>")).toBe("array");
  });

  test("a Promise is unwrapped to the category of what it resolves to", () => {
    expect(categorizeType("Promise<User>")).toBe("object");
    expect(categorizeType("Promise<void>")).toBe("void");
    expect(categorizeType("Promise<string[]>")).toBe("array");
  });
});

describe("buildPinModel", () => {
  test("no signature means no pins", () => {
    expect(buildPinModel(null)).toBeNull();
  });

  test("an unparseable signature means no pins", () => {
    expect(buildPinModel("justAName")).toBeNull();
  });

  test("a call with neither params nor a return type shows no pins", () => {
    expect(buildPinModel("noop()")).toBeNull();
  });

  test("inputs carry their categorised type; the return becomes the output pin", () => {
    expect(buildPinModel("greet(name: string): void")).toEqual({
      inputs: [{ name: "name", type: "string", optional: false, rest: false, category: "string" }],
      output: { type: "void", category: "void" },
      hiddenInputs: 0,
    });
  });

  test("a call with params but no return type has a null output", () => {
    const model = buildPinModel("push(x: number)");
    expect(model?.output).toBeNull();
    expect(model?.inputs).toHaveLength(1);
  });

  test("a call with a return type but no params has an output and no inputs", () => {
    const model = buildPinModel("now(): number");
    expect(model?.inputs).toEqual([]);
    expect(model?.output).toEqual({ type: "number", category: "number" });
  });

  test("input pins beyond the cap are dropped and counted in hiddenInputs", () => {
    const many = Array.from({ length: MAX_INPUT_PINS + 3 }, (_, i) => `a${i}: number`).join(", ");
    const model = buildPinModel(`big(${many}): void`);
    expect(model?.inputs).toHaveLength(MAX_INPUT_PINS);
    expect(model?.hiddenInputs).toBe(3);
  });

  test("each input's category is derived from its own type", () => {
    const model = buildPinModel("save(flag: boolean, rows: User[]): Promise<Thing>");
    expect(model?.inputs.map((pin) => pin.category)).toEqual(["bool", "array"]);
    expect(model?.output?.category).toBe("object");
  });
});
