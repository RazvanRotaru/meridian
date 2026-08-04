import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { sendJsonFile } from "./http-response";

describe("sendJsonFile", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("streams the immutable payload with its exact byte length", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-json-response-"));
    roots.push(root);
    const path = join(root, "projection.json");
    const body = JSON.stringify({ symbol: "λ", ready: true });
    await writeFile(path, body, "utf8");

    const chunks: Buffer[] = [];
    let status: number | null = null;
    let headers: OutgoingHttpHeaders | null = null;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }) as unknown as ServerResponse;
    sink.writeHead = ((nextStatus: number, nextHeaders: OutgoingHttpHeaders) => {
      status = nextStatus;
      headers = nextHeaders;
      return sink;
    }) as ServerResponse["writeHead"];

    await sendJsonFile(sink, path, { "x-meridian-test": "exact" });

    expect(status).toBe(200);
    expect(headers).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
      "x-meridian-test": "exact",
    });
    expect(Buffer.concat(chunks).toString("utf8")).toBe(body);
  });
});
