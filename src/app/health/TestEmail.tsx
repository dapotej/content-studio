"use client";
import { useState } from "react";

/** Sends a test email to the owner, so the email set-up can be checked from here. */
export function TestEmail() {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  async function go() {
    setState("busy");
    const res = await fetch("/api/admin/test-email", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (res.ok) { setState("done"); setMsg(`Sent to ${body.to}. Check your inbox (and spam).`); }
    else { setState("error"); setMsg(body.error ?? "Could not send."); }
  }
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" className="btn" onClick={go} disabled={state === "busy"}>{state === "busy" ? "Sending…" : "Send a test email"}</button>
      {msg && <span className={state === "error" ? "error" : "muted"} role="status" style={{ overflowWrap: "anywhere" }}>{msg}</span>}
    </div>
  );
}
