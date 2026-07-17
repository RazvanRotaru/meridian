import { describe, expect, it, vi } from "vitest";
import { OwnershipCleanupError, withOwnershipCleanup } from "./ownership-cleanup";

describe("withOwnershipCleanup", () => {
  it.each([undefined, null, false, 0, ""])(
    "preserves a falsy primary failure (%s) when cleanup succeeds",
    async (primaryError) => {
      const cleanup = vi.fn(async () => undefined);

      const outcome = await withOwnershipCleanup(
        () => { throw primaryError; },
        [cleanup],
        "operation",
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

      expect(outcome).toEqual({ status: "rejected", error: primaryError });
      expect(cleanup).toHaveBeenCalledOnce();
    },
  );

  it("runs every cleanup in declaration order and aggregates all failures", async () => {
    const primaryError = new Error("primary");
    const firstCleanupError = new Error("first cleanup");
    const secondCleanupError = new Error("second cleanup");
    const order: string[] = [];

    const outcome = await withOwnershipCleanup(
      () => {
        order.push("operation");
        throw primaryError;
      },
      [
        () => {
          order.push("first cleanup");
          throw firstCleanupError;
        },
        async () => {
          order.push("second cleanup");
          throw secondCleanupError;
        },
        () => { order.push("third cleanup"); },
      ],
      "publication",
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(order).toEqual(["operation", "first cleanup", "second cleanup", "third cleanup"]);
    expect(outcome).toBeInstanceOf(OwnershipCleanupError);
    expect(outcome).toMatchObject({
      name: "OwnershipCleanupError",
      message: "publication and ownership cleanup failed",
    });
    expect((outcome as OwnershipCleanupError).errors)
      .toEqual([primaryError, firstCleanupError, secondCleanupError]);
  });

  it("retains a falsy primary failure and flattens nested cleanup failures", async () => {
    const nestedOne = new Error("nested one");
    const nestedTwo = new Error("nested two");
    const finalCleanup = new Error("final cleanup");

    const outcome = await withOwnershipCleanup(
      () => { throw undefined; },
      [
        () => { throw new OwnershipCleanupError([nestedOne, nestedTwo], "nested"); },
        () => { throw finalCleanup; },
      ],
      "outer",
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(OwnershipCleanupError);
    expect((outcome as OwnershipCleanupError).errors)
      .toEqual([undefined, nestedOne, nestedTwo, finalCleanup]);
  });

  it("returns the operation value after successful cleanup", async () => {
    const cleanup = vi.fn(async () => undefined);

    await expect(withOwnershipCleanup(() => 0, [cleanup], "operation")).resolves.toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
