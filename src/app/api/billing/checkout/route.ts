import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/accounts";
import { handle } from "@/lib/http";
import { PaymentError, paymentProviderFor, paystackCheckout, stripeCheckout } from "@/lib/payments";
import { isComplimentary } from "@/lib/plans";

const Body = z.object({ plan: z.enum(["starter", "growth", "agency"]) });

/** Starts a subscription: returns the provider's checkout page. Owners only. */
export const POST = handle(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "owner") return NextResponse.json({ error: "Only the workspace owner can change the plan." }, { status: 403 });
  if (isComplimentary(s.workspace.plan)) return NextResponse.json({ error: "This workspace is complimentary; it has no plan to buy." }, { status: 400 });
  const { plan } = Body.parse(await req.json());
  const provider = paymentProviderFor(s.workspace, req.headers.get("x-vercel-ip-country"));
  const origin = new URL(req.url).origin;
  try {
    const url = provider === "stripe" ? await stripeCheckout(s.workspace, plan, s.user.email, origin) : await paystackCheckout(s.workspace, plan, s.user.email, origin);
    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 502 });
    throw e;
  }
});
