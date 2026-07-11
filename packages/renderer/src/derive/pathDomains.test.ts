import { describe, expect, it } from "vitest";
import { groupByPathDomain } from "./pathDomains";

describe("groupByPathDomain", () => {
  it("uses the first directory below the dominant source root", () => {
    const domains = groupByPathDomain([
      { id: "components/a", file: "src/aria/app/components/a.ts" },
      { id: "components/b", file: "src/aria/app/components/b.ts" },
      { id: "services/a", file: "src/aria/app/services/a.ts" },
      { id: "services/b", file: "src/aria/app/services/b.ts" },
      { id: "backend/a", file: "src/aria/app/backend/a.ts" },
      { id: "backend/b", file: "src/aria/app/backend/b.ts" },
    ]);

    expect(domains.map(({ label, ids }) => ({ label, ids }))).toEqual([
      { label: "backend", ids: ["backend/a", "backend/b"] },
      { label: "components", ids: ["components/a", "components/b"] },
      { label: "services", ids: ["services/a", "services/b"] },
    ]);
  });

  it("does not let a few root outliers collapse every source path into src", () => {
    const domains = groupByPathDomain([
      { id: "components/a", file: "src/components/a.ts" },
      { id: "components/b", file: "src/components/b.ts" },
      { id: "lib/a", file: "src/lib/a.ts" },
      { id: "lib/b", file: "src/lib/b.ts" },
      { id: "services/a", file: "src/services/a.ts" },
      { id: "services/b", file: "src/services/b.ts" },
      { id: "analytics", file: "analytics/report.ts" },
    ]);

    expect(domains.map((domain) => domain.label)).toEqual(["analytics", "components", "lib", "services"]);
  });

  it("is deterministic under input reversal and keeps pathless leads in a stable root group", () => {
    const entries = [
      { id: "b", file: "src/app/tools/b.ts" },
      { id: "a", file: "src/app/tools/a.ts" },
      { id: "unknown", file: null },
    ];
    expect(groupByPathDomain(entries)).toEqual(groupByPathDomain([...entries].reverse()));
    expect(groupByPathDomain(entries).find((domain) => domain.label === "(root)")?.ids).toEqual(["unknown"]);
  });
});
