"use client";
import { useState } from "react";
import type { Plan, PlanId, PlanStatus } from "@/lib/plans";

export function CopyLink({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-link">
      <span className="small">{label}</span>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input type="text" readOnly value={url} aria-label="Link" onFocus={(e) => e.currentTarget.select()} />
        <button className="btn" type="button" onClick={async () => { await navigator.clipboard.writeText(url).catch(() => undefined); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

/** Plan cards in the workspace's currency: naira through Paystack, or US dollars by card through Stripe. */
export function BillingPlans({ current, status, owner, provider, plans, ready, countryName }: {
  current: PlanId; status: PlanStatus; owner: boolean; provider: "stripe" | "paystack";
  plans: (Plan & { id: "starter" | "growth" | "agency" })[]; ready: boolean; countryName: string;
}) {
  const currency = provider === "paystack" ? "ngn" : "usd";
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const paid = current !== "trial" && current !== "internal" && current !== "free" && status !== "canceled";

  async function go(path: string, body?: unknown, key = path) {
    setBusy(key); setError("");
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) { setBusy(null); return setError(data.error ?? "Something went wrong. Try again."); }
    window.location.href = data.url;
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small muted">
          {currency === "ngn" ? "Prices in naira, paid with Paystack (card, bank transfer or USSD)" : "Prices in US dollars, paid by card"}{countryName ? ` · ${countryName}` : ""}
        </span>
        {paid && owner && <button className="btn" type="button" onClick={() => go("/api/billing/manage", undefined, "manage")} disabled={busy !== null}>{busy === "manage" ? "Opening…" : "Manage billing"}</button>}
      </div>
      <div className="plans">
        {plans.map((p) => {
          const isCurrent = paid && current === p.id;
          return (
            <div key={p.id} className={`plan ${isCurrent ? "current" : ""}`}>
              <div className="row" style={{ justifyContent: "space-between" }}><strong>{p.name}</strong>{isCurrent && <span className="chip chip-ok">Your plan</span>}</div>
              <p className="price">{currency === "usd" ? `$${p.usd}` : `₦${(p.ngn ?? 0).toLocaleString("en-NG")}`}<span>/month</span></p>
              <p className="small muted">{p.blurb}</p>
              <ul>{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
              {!isCurrent && (
                <button className="btn btn-ink" type="button" disabled={!owner || !ready || busy !== null}
                  onClick={() => go("/api/billing/checkout", { plan: p.id }, p.id)}>
                  {busy === p.id ? "Opening checkout…" : paid ? `Switch to ${p.name}` : `Choose ${p.name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {!ready && <p className="small muted">Payments aren&rsquo;t switched on yet.</p>}
      {!owner && <p className="small muted">Only the workspace owner can change the plan.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
