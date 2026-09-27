import { z } from "zod";
import { sha256 } from "@semantic-ir/core";
import { parseStrictJson } from "./quality.js";

const identifier = z.string().min(1).max(200);
const integer = z.number().int().safe();
const amount = integer.nonnegative();
const path = z.array(z.union([z.string(), amount])).max(100);
const lineSchema = z.object({ sku: identifier, qty: integer,
  quoted_price_cents: amount.optional() }).strict();
export const AllocationInputSchema = z.object({
  products: z.array(z.object({ sku: identifier, name: z.string().optional(), price_cents: amount,
    cost_cents: amount, enabled: z.boolean() }).strict()).min(1).max(10_000),
  stocks: z.array(z.object({ warehouse: identifier, sku: identifier, on_hand: amount,
    reserved: amount }).strict()).min(1).max(100_000),
  routes: z.record(identifier, z.array(z.object({ warehouse: identifier,
    shipping_cents: amount }).strict()).min(1).max(100)),
  minimum_contribution_cents: amount,
  orders: z.array(z.object({ id: identifier, revision: amount, event_seq: amount,
    status: z.enum(["active", "cancelled"]), priority: integer,
    created_at: z.iso.datetime().regex(/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/), destination: identifier,
    discount_bps: amount.max(10_000), external_ref: z.string(),
    items: z.array(lineSchema).min(1).max(10_000), customer_note: z.string().optional(),
  }).strict()).max(100_000),
}).strict();
export const LocalTaskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json_select_v1"), data: z.json(), path,
    where: z.object({ path, equals: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]) }).strict().optional(),
    select: path.optional(), cardinality: z.enum(["one", "many"]).optional(),
  }).strict(),
  z.object({ kind: z.literal("order_allocation_v1"), data: AllocationInputSchema }).strict(),
]);
export type LocalTask = z.infer<typeof LocalTaskSchema>;
type AllocationInput = z.infer<typeof AllocationInputSchema>;

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function checked(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("Arithmetic result exceeds safe JSON integer range");
  }
  return Number(value);
}
function readPath(data: unknown, parts: (string | number)[]): unknown {
  let value = data;
  for (const part of parts) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part) ||
      (Array.isArray(value) && (typeof part !== "number" || part >= value.length))) {
      throw new Error("JSON path does not exist");
    }
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}

/** Versioned business contract, explicitly selected by the caller; no NLP inference or code execution. */
function allocate(data: AllocationInput) {
  const products = new Map(data.products.map(p => [p.sku, p]));
  if (products.size !== data.products.length) throw new Error("Duplicate product SKU");
  const stock = new Map<string, Map<string, number>>();
  for (const item of data.stocks) {
    if (!products.has(item.sku)) throw new Error("Stock references unknown SKU");
    if (item.reserved > item.on_hand) throw new Error("Reserved stock exceeds on_hand");
    const warehouse = stock.get(item.warehouse) ?? new Map<string, number>();
    if (warehouse.has(item.sku)) throw new Error("Duplicate warehouse/SKU stock");
    warehouse.set(item.sku, item.on_hand - item.reserved);
    stock.set(item.warehouse, warehouse);
  }
  for (const warehouse of stock.values()) {
    if (warehouse.size !== products.size) throw new Error("Each warehouse needs stock for every SKU (zero is allowed)");
  }
  for (const routes of Object.values(data.routes)) {
    if (new Set(routes.map(r => r.warehouse)).size !== routes.length) throw new Error("Duplicate route warehouse");
    for (const route of routes) if (!stock.has(route.warehouse)) throw new Error("Route references unknown warehouse");
  }
  const latest = new Map<string, AllocationInput["orders"][number]>();
  const eventKeys = new Set<string>();
  for (const event of data.orders) {
    const key = JSON.stringify([event.id, event.revision, event.event_seq]);
    if (eventKeys.has(key)) throw new Error("Ambiguous duplicate event version");
    eventKeys.add(key);
    if (!Object.hasOwn(data.routes, event.destination)) throw new Error("Unknown order destination");
    const previous = latest.get(event.id);
    if (!previous || event.revision > previous.revision ||
      (event.revision === previous.revision && event.event_seq > previous.event_seq)) latest.set(event.id, event);
  }
  const kept = [...latest.values()];
  const active = kept.filter(o => o.status === "active").sort((a, b) =>
    (a.priority > b.priority ? -1 : a.priority < b.priority ? 1 : 0) ||
    Date.parse(a.created_at) - Date.parse(b.created_at) || compare(a.id, b.id));
  const approved: { id: string; external_ref: string; warehouse: string; gross_cents: number;
    discount_cents: number; net_cents: number; shipping_cents: number; contribution_cents: number }[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const order of active) {
    if (order.items.some(i => i.qty <= 0 || !products.get(i.sku)?.enabled)) {
      rejected.push({ id: order.id, reason: "invalid_item" });
      continue;
    }
    const quantities = new Map<string, bigint>();
    for (const item of order.items) quantities.set(item.sku, (quantities.get(item.sku) ?? 0n) + BigInt(item.qty));
    let gross = 0n;
    let goods = 0n;
    for (const [sku, qty] of quantities) {
      gross += BigInt(products.get(sku)!.price_cents) * qty;
      goods += BigInt(products.get(sku)!.cost_cents) * qty;
    }
    const discount = gross * BigInt(order.discount_bps) / 10_000n;
    const net = gross - discount;
    let hadStock = false;
    let accepted = false;
    for (const route of data.routes[order.destination]!) {
      const warehouse = stock.get(route.warehouse)!;
      if (![...quantities].every(([sku, qty]) => BigInt(warehouse.get(sku)!) >= qty)) continue;
      hadStock = true;
      const contribution = net - goods - BigInt(route.shipping_cents);
      if (contribution < BigInt(data.minimum_contribution_cents)) continue;
      const row = { id: order.id, external_ref: order.external_ref, warehouse: route.warehouse,
        gross_cents: checked(gross), discount_cents: checked(discount), net_cents: checked(net),
        shipping_cents: route.shipping_cents, contribution_cents: checked(contribution) };
      for (const [sku, qty] of quantities) warehouse.set(sku, checked(BigInt(warehouse.get(sku)!) - qty));
      approved.push(row);
      accepted = true;
      break;
    }
    if (!accepted) rejected.push({ id: order.id, reason: hadStock ? "insufficient_margin" : "insufficient_stock" });
  }
  const amounts = ["gross_cents", "discount_cents", "net_cents", "shipping_cents", "contribution_cents"] as const;
  const totals = Object.fromEntries(amounts.map(key => [key, checked(approved.reduce((sum, row) => sum + BigInt(row[key]), 0n))]));
  return { approved, rejected, cancelled: kept.filter(o => o.status === "cancelled").map(o => o.id).sort(compare),
    superseded_events: data.orders.length - kept.length,
    totals: { approved_count: approved.length, rejected_count: rejected.length, ...totals },
    remaining: Object.fromEntries([...stock].map(([warehouse, quantities]) => [warehouse, Object.fromEntries(quantities)])) };
}

/** No adapter is accepted: these operations cannot accidentally make a provider call. */
export function executeLocalTask(input: unknown) {
  const task = LocalTaskSchema.parse(input);
  parseStrictJson(JSON.stringify(task));
  let output: unknown;
  if (task.kind === "order_allocation_v1") output = allocate(task.data);
  else {
    let selected = readPath(task.data, task.path);
    if (task.where) {
      if (!Array.isArray(selected)) throw new Error("where requires an array");
      const { path, equals } = task.where;
      const matches = selected.filter(item => readPath(item, path) === equals);
      if ((task.cardinality ?? "one") === "one") {
        if (matches.length !== 1) throw new Error("Expected exactly one matching record");
        selected = matches[0];
      } else selected = matches;
    } else if (task.cardinality !== undefined) throw new Error("cardinality requires where");
    output = task.select ? (task.where && task.cardinality === "many"
      ? (selected as unknown[]).map(item => readPath(item, task.select!)) : readPath(selected, task.select)) : selected;
  }
  return { mode: "local" as const, task: task.kind, result: output,
    verification: { status: "verified_contract" as const, contract: task.kind,
      inputSha256: sha256(JSON.stringify(input)), resultSha256: sha256(JSON.stringify(output)),
      scope: "Explicit structured contract; does not establish equivalence to arbitrary natural-language instructions" },
    usage: { providerCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
      scope: "downstream_execution" as const }, costUsd: 0 };
}
