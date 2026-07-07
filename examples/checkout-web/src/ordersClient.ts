/** The checkout front end's HTTP client — every exit port this system has. */

export interface OrderSummary {
  id: string;
  totalCents: number;
}

export async function listOrders(): Promise<OrderSummary[]> {
  const response = await fetch("/api/orders");
  return response.json();
}

export async function getOrder(id: string): Promise<OrderSummary> {
  // A concrete path the linker must unify onto the api's `/api/orders/:id` template.
  const response = await fetch("/api/orders/123");
  return response.json();
}

export async function placeOrder(body: unknown): Promise<OrderSummary> {
  const response = await fetch("/api/orders", { method: "POST" });
  return response.json();
}

/** No server in the linked system serves this — a dangling exit the graph should surface. */
export async function fetchRecommendations(): Promise<unknown> {
  const response = await fetch("/api/recommendations");
  return response.json();
}

/** Dynamic URL: statically unknowable, must surface as a dynamic port, never a guess. */
export async function fetchFrom(base: string): Promise<unknown> {
  const response = await fetch(`${base}/api/orders`);
  return response.json();
}
