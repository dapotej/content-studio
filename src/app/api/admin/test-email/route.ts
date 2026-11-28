import { NextResponse } from "next/server";
import { requireSession } from "@/lib/accounts";
import { emailProvider, sendEmailDetailed } from "@/lib/email";
import { handle } from "@/lib/http";

/** Internal: sends a test email to the signed-in owner, and reports the provider's answer. */
export const POST = handle(async () => {
  const s = await requireSession();
  if (s.workspace.plan !== "internal" || s.role !== "owner") return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const r = await sendEmailDetailed(s.user.email, "Buzzbite test email",
    `This is a test from Buzzbite. Email is working: notification digests, failed-post alerts and password reset links will reach you.\n\nSent with ${emailProvider() === "zoho" ? "Zoho" : "Resend"}.`);
  return r.ok ? NextResponse.json({ ok: true, to: s.user.email }) : NextResponse.json({ error: r.error }, { status: 502 });
});
