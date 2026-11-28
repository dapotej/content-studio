import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { findWorkspaceByBilling, getWorkspace, setWorkspacePlan, type Workspace } from "./accounts";
import { notifyWorkspace } from "./notify";
import { PLANS, isComplimentary, providerForCountry, type PaidPlanId, type PlanStatus } from "./plans";

// Stripe (cards, USD) and Paystack (NGN), called over their REST APIs. Each stays
// switched off until its keys are set in the environment.
export class PaymentError extends Error {}

export const stripeReady = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_PRICE_STARTER);
/**
 * How this workspace pays: a workspace already paying keeps its provider; otherwise its country
 * decides (Paystack in naira for Nigeria, Stripe in USD elsewhere), falling back to Stripe while
 * Paystack isn't set up.
 */
export function paymentProviderFor(ws: Workspace, ipCountry?: string | null): "stripe" | "paystack" {
  if (ws.billing.provider && ws.billing.subscriptionId && ws.plan_status !== "canceled") return ws.billing.provider;
  const wanted = providerForCountry(ws.country ?? ipCountry);
  return wanted === "paystack" && !paystackReady() ? "stripe" : wanted;
}

export const paystackReady = () => Boolean(process.env.PAYSTACK_SECRET_KEY && process.env.PAYSTACK_PLAN_STARTER);

const stripePrice = (plan: PaidPlanId) => process.env[`STRIPE_PRICE_${plan.toUpperCase()}`];
const paystackPlan = (plan: PaidPlanId) => process.env[`PAYSTACK_PLAN_${plan.toUpperCase()}`];
const planFromStripePrice = (price: string | undefined): PaidPlanId | null =>
  (["starter", "growth", "agency"] as PaidPlanId[]).find((p) => stripePrice(p) === price) ?? null;
const isPaidPlan = (p: unknown): p is PaidPlanId => p === "starter" || p === "growth" || p === "agency";

// ---------- Stripe ----------
// Hosted Checkout (subscription mode) to subscribe, the Customer Portal to switch plans, update
// the card or cancel, and webhooks to keep the workspace in step. One Stripe customer and at
// most one subscription per workspace.
async function stripe<T>(path: string, form: Record<string, string> | null, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` };
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1${path}`, { method: form ? "POST" : "GET", headers, body: form ? new URLSearchParams(form).toString() : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PaymentError(data?.error?.message ?? `Stripe error (${res.status}).`);
  return data as T;
}

/** The workspace's Stripe customer, created once and reused for every checkout. */
async function stripeCustomer(ws: Workspace, email: string): Promise<string> {
  // The same field holds a Paystack customer code for naira workspaces; only reuse a Stripe id.
  if (ws.billing.customerId?.startsWith("cus_")) return ws.billing.customerId;
  const c = await stripe<{ id: string }>("/customers", { email, name: ws.name, "metadata[workspace_id]": ws.id }, { idempotencyKey: `customer-${ws.id}` });
  await setWorkspacePlan(ws.id, { billing: { customerId: c.id } });
  return c.id;
}

/** True when the workspace already pays by card: plan changes then go through the portal. */
const hasStripeSubscription = (ws: Workspace) => ws.billing.provider === "stripe" && !!ws.billing.subscriptionId && ws.plan_status !== "canceled";

export async function stripeCheckout(ws: Workspace, plan: PaidPlanId, email: string, origin: string): Promise<string> {
  const price = stripePrice(plan);
  if (!stripeReady() || !price) throw new PaymentError("Card payments aren't switched on yet.");
  // Already subscribed: switch plans in the portal instead of starting a second subscription.
  if (hasStripeSubscription(ws)) return stripePortal(ws, origin, true);
  const customer = await stripeCustomer(ws, email);
  const form: Record<string, string> = {
    mode: "subscription",
    customer,
    "line_items[0][price]": price, "line_items[0][quantity]": "1",
    success_url: `${origin}/settings?billing=success#billing`, cancel_url: `${origin}/settings#billing`,
    client_reference_id: ws.id, "metadata[workspace_id]": ws.id, "metadata[plan]": plan,
    "subscription_data[metadata][workspace_id]": ws.id, "subscription_data[metadata][plan]": plan,
    "subscription_data[billing_mode][type]": "flexible",
    allow_promotion_codes: "true",
    "customer_update[name]": "auto", "customer_update[address]": "auto",
  };
  return (await stripe<{ url: string }>("/checkout/sessions", form)).url;
}

export async function stripePortal(ws: Workspace, origin: string, toPlans = false): Promise<string> {
  if (!ws.billing.customerId) throw new PaymentError("No card subscription to manage.");
  const form: Record<string, string> = { customer: ws.billing.customerId, return_url: `${origin}/settings#billing` };
  if (process.env.STRIPE_PORTAL_CONFIG) form.configuration = process.env.STRIPE_PORTAL_CONFIG;
  // Straight to "change plan" when the owner picked another plan in Buzzbite.
  if (toPlans && ws.billing.subscriptionId) Object.assign(form, { "flow_data[type]": "subscription_update", "flow_data[subscription_update][subscription]": ws.billing.subscriptionId });
  return (await stripe<{ url: string }>("/billing_portal/sessions", form)).url;
}

/** Checks the Stripe-Signature header (t=…,v1=…) against the raw body. */
export function verifyStripeSignature(raw: string, header: string | null): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest();
  return header.split(",").filter((kv) => kv.startsWith("v1=")).some((kv) => {
    const sig = Buffer.from(kv.slice(3), "hex");
    return sig.length === expected.length && timingSafeEqual(sig, expected);
  });
}

const stripeStatus = (s: string): PlanStatus => (s === "active" || s === "trialing" ? "active" : s === "past_due" || s === "unpaid" ? "past_due" : "canceled");

type StripeEvent = { id?: string; type: string; created?: number; data: { object: Record<string, any> } };

/** Newer API versions keep the period end on the subscription item; older ones on the subscription. */
function periodEnd(sub: Record<string, any>): string | undefined {
  const t = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  return t ? new Date(t * 1000).toISOString() : undefined;
}

async function workspaceFor(o: Record<string, any>, subscriptionId?: string): Promise<Workspace | null> {
  const wsId = o.metadata?.workspace_id ?? o.subscription_details?.metadata?.workspace_id ?? o.parent?.subscription_details?.metadata?.workspace_id;
  return (wsId && (await getWorkspace(wsId)))
    || (subscriptionId ? await findWorkspaceByBilling("subscriptionId", subscriptionId) : null)
    || (o.customer ? await findWorkspaceByBilling("customerId", o.customer) : null);
}

export async function handleStripeEvent(e: StripeEvent): Promise<void> {
  const o = e.data.object;
  if (e.type === "checkout.session.completed") {
    const wsId = o.metadata?.workspace_id ?? o.client_reference_id;
    const plan = o.metadata?.plan;
    const target = wsId ? await getWorkspace(wsId) : null;
    if (!wsId || !isPaidPlan(plan) || !target || isComplimentary(target.plan)) return;
    await setWorkspacePlan(wsId, { plan, plan_status: "active", billing: { provider: "stripe", customerId: o.customer, subscriptionId: o.subscription, cancelAtPeriodEnd: false } });
    return;
  }
  if (e.type === "customer.subscription.created" || e.type === "customer.subscription.updated" || e.type === "customer.subscription.deleted") {
    const ws = await workspaceFor(o, o.id);
    if (!ws || isComplimentary(ws.plan)) return; // complimentary workspaces are never changed by billing
    // Events can arrive out of order: never let an older one undo a newer change.
    if (e.created && ws.billing.lastEventAt && e.created < ws.billing.lastEventAt) return;
    // Another subscription than the workspace's current one (e.g. an old cancelled one): ignore.
    if (ws.billing.subscriptionId && ws.billing.subscriptionId !== o.id && e.type === "customer.subscription.deleted") return;
    const plan = planFromStripePrice(o.items?.data?.[0]?.price?.id) ?? (isPaidPlan(o.metadata?.plan) ? o.metadata.plan : null);
    await setWorkspacePlan(ws.id, {
      ...(plan ? { plan } : {}),
      plan_status: e.type === "customer.subscription.deleted" ? "canceled" : stripeStatus(o.status),
      billing: {
        provider: "stripe", subscriptionId: o.id, customerId: o.customer, currentPeriodEnd: periodEnd(o),
        cancelAtPeriodEnd: Boolean(o.cancel_at_period_end || o.cancel_at), ...(e.created ? { lastEventAt: e.created } : {}),
      },
    });
    return;
  }
  if (e.type === "invoice.paid" || e.type === "invoice.payment_failed") {
    const subId = o.subscription ?? o.parent?.subscription_details?.subscription;
    if (!subId) return;
    const ws = await workspaceFor(o, subId);
    if (!ws || isComplimentary(ws.plan) || ws.billing.subscriptionId !== subId) return;
    if (e.type === "invoice.paid") {
      if (ws.plan_status === "past_due") await setWorkspacePlan(ws.id, { plan_status: "active" });
      return;
    }
    await setWorkspacePlan(ws.id, { plan_status: "past_due" });
    await notifyWorkspace(ws.id, {
      kind: "failed", dedupe: `payment-failed:${o.id}`,
      title: "Your Buzzbite payment didn't go through",
      body: "Update your card in Settings → Plan and billing. Stripe will try again over the next few days; posting stops if it can't be paid.",
      link: "/settings#billing",
    });
  }
}

// ---------- Paystack ----------
async function paystack<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.status === false) throw new PaymentError(data?.message ?? `Paystack error (${res.status}).`);
  return data.data as T;
}

export async function paystackCheckout(ws: Workspace, plan: PaidPlanId, email: string, origin: string): Promise<string> {
  const code = paystackPlan(plan);
  if (!paystackReady() || !code) throw new PaymentError("Naira payments aren't switched on yet.");
  const amount = (PLANS[plan].ngn ?? 0) * 100; // kobo; the plan's own amount is what's charged
  const d = await paystack<{ authorization_url: string }>("POST", "/transaction/initialize", {
    email, amount, plan: code, callback_url: `${origin}/settings?billing=paystack`, metadata: { workspace_id: ws.id, plan },
  });
  return d.authorization_url;
}

export async function paystackManageLink(ws: Workspace): Promise<string> {
  if (!ws.billing.subscriptionId) throw new PaymentError("No naira subscription to manage.");
  return (await paystack<{ link: string }>("GET", `/subscription/${ws.billing.subscriptionId}/manage/link`)).link;
}

/** After Paystack sends the customer back: confirm the payment straight away rather than wait for the webhook. */
export async function paystackConfirm(reference: string, workspaceId: string): Promise<boolean> {
  if (!paystackReady() || !/^[\w-]{4,100}$/.test(reference)) return false;
  const d = await paystack<{ status: string; metadata?: { workspace_id?: string; plan?: string }; customer?: { customer_code?: string } }>("GET", `/transaction/verify/${reference}`);
  if (d.status !== "success" || d.metadata?.workspace_id !== workspaceId || !isPaidPlan(d.metadata?.plan)) return false;
  const ws = await getWorkspace(workspaceId);
  const switching = ws?.billing.provider !== "paystack";
  await setWorkspacePlan(workspaceId, { plan: d.metadata.plan, plan_status: "active", billing: { provider: "paystack", customerId: d.customer?.customer_code, ...(switching ? { subscriptionId: undefined, emailToken: undefined } : {}) } });
  return true;
}

/** Paystack signs the raw body with HMAC-SHA512 using the secret key. */
export function verifyPaystackSignature(raw: string, header: string | null): boolean {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !header) return false;
  const expected = createHmac("sha512", secret).update(raw).digest();
  const sig = Buffer.from(header, "hex");
  return sig.length === expected.length && timingSafeEqual(sig, expected);
}

type PaystackEvent = { event: string; data: Record<string, any> };

export async function handlePaystackEvent(e: PaystackEvent): Promise<void> {
  const d = e.data;
  const customer = d.customer?.customer_code as string | undefined;
  if (e.event === "charge.success") {
    const wsId = d.metadata?.workspace_id;
    const plan = d.metadata?.plan;
    const target = wsId ? await getWorkspace(wsId) : null;
    if (target && isComplimentary(target.plan)) return;
    if (wsId && isPaidPlan(plan) && target) {
      await setWorkspacePlan(wsId, { plan, plan_status: "active", billing: { provider: "paystack", customerId: customer, subscriptionId: undefined, emailToken: undefined } });
    } else if (customer) {
      // A renewal: no metadata, found by customer.
      const ws = await findWorkspaceByBilling("customerId", customer);
      if (ws && !isComplimentary(ws.plan)) await setWorkspacePlan(ws.id, { plan_status: "active" });
    }
    return;
  }
  const ws = (d.subscription_code && (await findWorkspaceByBilling("subscriptionId", d.subscription_code))) || (customer && (await findWorkspaceByBilling("customerId", customer)));
  if (!ws || isComplimentary(ws.plan)) return;
  if (e.event === "subscription.create") {
    await setWorkspacePlan(ws.id, { billing: { provider: "paystack", subscriptionId: d.subscription_code, emailToken: d.email_token, currentPeriodEnd: d.next_payment_date } });
  } else if (e.event === "invoice.payment_failed") {
    await setWorkspacePlan(ws.id, { plan_status: "past_due" });
  } else if (e.event === "subscription.disable") {
    await setWorkspacePlan(ws.id, { plan_status: "canceled" });
  }
}
