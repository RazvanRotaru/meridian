import { describe, expect, it, vi } from "vitest";

const evaluations = vi.hoisted(() => ({ webCommand: 0 }));

vi.mock("./commands/web", () => {
  evaluations.webCommand += 1;
  return { runWeb: vi.fn() };
});

describe("CLI command registration memory boundary", () => {
  it("registers web without evaluating the web command implementation", async () => {
    const { buildProgram } = await import("./program");
    const program = buildProgram();

    expect(program.commands.map((command) => command.name())).toContain("web");
    expect(evaluations.webCommand).toBe(0);
  });
});
