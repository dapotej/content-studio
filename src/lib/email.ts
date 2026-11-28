import "server-only";

// Email: notifications digests, failed-post alerts and password reset links.
// Sent with Zoho (CPaaS / ZeptoMail send mail token) when ZOHO_SEND_TOKEN is set, otherwise
// with Resend when RESEND_API_KEY is set. With neither, nothing is sent and the app falls back
// (alerts stay in the app; reset links are made by the workspace owner).
//
//   ZOHO_SEND_TOKEN  the agent's send mail token (Zoho: Agents > SMTP/API > API), without the
//                    "Zoho-enczapikey" prefix
//   ZOHO_MAIL_HOST   the API host shown next to the token (default api.zeptomail.com;
//                    e.g. api.zeptomail.eu for EU accounts)
//   EMAIL_FROM       "Buzzbite <hello@buzzbite.io>": an address on a domain verified with the provider

const provider = (): "zoho" | "resend" | null =>
  process.env.ZOHO_SEND_TOKEN ? "zoho" : process.env.RESEND_API_KEY ? "resend" : null;
export const emailConfigured = () => provider() !== null;
export const emailProvider = () => provider();

function fromAddress(): { name: string; address: string } {
  const raw = process.env.EMAIL_FROM || "Buzzbite <hello@buzzbite.io>";
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  return m ? { name: m[1] || "Buzzbite", address: m[2] } : { name: "Buzzbite", address: raw.trim() };
}

export type EmailResult = { ok: boolean; error?: string };

async function sendZoho(to: string[], subject: string, text: string): Promise<EmailResult> {
  const host = (process.env.ZOHO_MAIL_HOST || "api.zeptomail.com").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const token = (process.env.ZOHO_SEND_TOKEN || "").replace(/^zoho-enczapikey\s+/i, "");
  const res = await fetch(`https://${host}/v1.1/email`, {
    method: "POST",
    headers: { authorization: `Zoho-enczapikey ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      from: fromAddress(),
      to: to.map((address) => ({ email_address: { address } })),
      subject,
      textbody: text,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, error: `Zoho returned ${res.status}: ${body.slice(0, 300)}` };
}

async function sendResend(to: string[], subject: string, text: string): Promise<EmailResult> {
  const f = fromAddress();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: `${f.name} <${f.address}>`, to, subject, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: `Resend returned ${res.status}: ${(await res.text()).slice(0, 300)}` };
}

/** Sends a plain-text email. Returns the provider's error instead of throwing. */
export async function sendEmailDetailed(to: string | string[], subject: string, text: string): Promise<EmailResult> {
  const p = provider();
  if (!p) return { ok: false, error: "Email isn't set up." };
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!list.length) return { ok: false, error: "No one to send to." };
  try {
    const r = p === "zoho" ? await sendZoho(list, subject, text) : await sendResend(list, subject, text);
    if (!r.ok) console.error("email failed", r.error);
    return r;
  } catch (e) {
    console.error("email failed", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function sendEmail(to: string | string[], subject: string, text: string): Promise<boolean> {
  return (await sendEmailDetailed(to, subject, text)).ok;
}
