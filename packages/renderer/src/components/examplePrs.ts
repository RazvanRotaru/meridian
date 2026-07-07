/**
 * Canned example PRs for the review-setup empty state, so a reader can see the lens work before they
 * have a real diff at hand. Each entry's `files` are already normalized to the served graph
 * (examples/-relative, "<example>/src/..."), so they feed VERBATIM into the same {paths, statusByFile}
 * shape a pasted `git diff --name-status` yields. Pure data; no React, no store.
 */

import type { ChangeStatus, ParsedAffectedInput } from "../derive/changeStatus";

export interface ExamplePr {
  number: number;
  title: string;
  url: string;
  files: { path: string; status: ChangeStatus }[];
}

export const EXAMPLE_PRS: ExamplePr[] = [
  {
    number: 76,
    title: "loyalty discount for orders-service",
    url: "https://github.com/RazvanRotaru/meridian/pull/76",
    files: [
      { path: "orders-service/src/pricing/pricingService.ts", status: "modified" },
      { path: "orders-service/src/services/orderService.ts", status: "modified" },
    ],
  },
  {
    number: 77,
    title: "shopfront refactor: dissolve the utils/legacy grab-bag",
    url: "https://github.com/RazvanRotaru/meridian/pull/77",
    files: [
      { path: "orders-service/src/domain/order.ts", status: "modified" },
      { path: "orders-service/src/notifications/emailService.ts", status: "modified" },
      { path: "shopfront/src/api/checkoutRoutes.ts", status: "modified" },
      { path: "shopfront/src/domain/cart.ts", status: "modified" },
      { path: "shopfront/src/domain/money.ts", status: "modified" },
      { path: "shopfront/src/domain/user.ts", status: "modified" },
      { path: "shopfront/src/repository/baseRepository.ts", status: "modified" },
      { path: "shopfront/src/repository/cartRepository.ts", status: "modified" },
      { path: "shopfront/src/repository/inventoryRepository.ts", status: "modified" },
      { path: "shopfront/src/repository/orderRepository.ts", status: "modified" },
      { path: "shopfront/src/repository/productRepository.ts", status: "modified" },
      { path: "shopfront/src/services/auditService.ts", status: "modified" },
      { path: "shopfront/src/services/cartService.ts", status: "modified" },
      { path: "shopfront/src/services/catalogService.ts", status: "modified" },
      { path: "shopfront/src/services/checkoutService.ts", status: "modified" },
      { path: "shopfront/src/services/inventoryService.ts", status: "modified" },
      { path: "shopfront/src/services/notificationService.ts", status: "modified" },
      { path: "shopfront/src/services/orderFactory.ts", status: "added" },
      { path: "shopfront/src/services/paymentService.ts", status: "modified" },
      { path: "shopfront/src/services/pricingService.ts", status: "modified" },
      { path: "shopfront/src/services/promotionService.ts", status: "modified" },
      { path: "shopfront/src/services/recommendationService.ts", status: "modified" },
      { path: "shopfront/src/services/userService.ts", status: "modified" },
      { path: "shopfront/src/ui/PriceTag.tsx", status: "modified" },
      { path: "shopfront/src/utils/clock.ts", status: "added" },
      { path: "shopfront/src/utils/clone.ts", status: "added" },
      { path: "shopfront/src/utils/collections.ts", status: "added" },
      { path: "shopfront/src/utils/ids.ts", status: "added" },
      { path: "shopfront/src/utils/legacy.ts", status: "removed" },
    ],
  },
];

/** Turn one example PR into the same {paths, statusByFile} shape `parseAffectedInput` yields. */
export function exampleAffectedInput(pr: ExamplePr): ParsedAffectedInput {
  return {
    paths: pr.files.map((file) => file.path),
    statusByFile: Object.fromEntries(pr.files.map((file) => [file.path, file.status])),
  };
}

/** The status breakdown ("N files · X modified · …") shown under an example row; zero counts drop out. */
export function exampleSummary(pr: ExamplePr): string {
  const total = pr.files.length;
  const counted: ChangeStatus[] = ["modified", "added", "removed", "renamed"];
  const parts = counted
    .map((status) => ({ status, count: pr.files.filter((file) => file.status === status).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.status}`);
  return [`${total} ${total === 1 ? "file" : "files"}`, ...parts].join(" · ");
}
