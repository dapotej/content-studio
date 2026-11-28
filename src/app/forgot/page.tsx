import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { findUserByEmail } from "@/lib/accounts";
import { appUrl } from "@/lib/alerts";
import { emailConfigured, sendEmail } from "@/lib/email";
import { LIMITS, RESET_LINK_HOURS, clientIp, createResetToken, limited, noteAttempt } from "@/lib/security";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset your password · Buzzbite" };

async function requestReset(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) redirect("/forgot?error=email");
  const emailKey = `reset:email:${email}`;
  const ipKey = `reset:ip:${await clientIp()}`;
  // Same answer whether or not the account exists, so the form can't be used to find accounts.
  if (!(await limited([[emailKey, LIMITS.resetEmail], [ipKey, LIMITS.resetIp]]))) {
    await noteAttempt(emailKey, ipKey);
    const user = await findUserByEmail(email);
    if (user) {
      const token = await createResetToken(user.id);
      await sendEmail(user.email, "Reset your Buzzbite password",
        `Someone asked to reset the password for your Buzzbite account.\n\nChoose a new password here (the link works once, for ${RESET_LINK_HOURS} hours):\n${appUrl()}/reset?token=${token}\n\nIf it wasn't you, ignore this email. Your password stays the same.`);
    }
  }
  redirect("/forgot?sent=1");
}

export default async function Forgot({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const { sent, error } = await searchParams;
  const back = <><Link href="/login">Back to sign in</Link></>;
  if (!emailConfigured()) {
    return <AuthShell title="Reset your password" lede="Ask the owner of your workspace for a reset link. They can make one in Settings, under Team." footer={back}>{null}</AuthShell>;
  }
  if (sent) {
    return <AuthShell title="Check your email" lede={`If that email has a Buzzbite account, a reset link is on its way. It works once, for ${RESET_LINK_HOURS} hours.`} footer={back}>{null}</AuthShell>;
  }
  return (
    <AuthShell title="Reset your password" lede="Enter your email and we'll send you a link to choose a new password." footer={back}>
      <form action={requestReset}>
        <label className="field" htmlFor="email">Email<input id="email" name="email" type="email" autoComplete="email" required autoFocus /></label>
        {error && <p className="error" role="alert">Enter a valid email address.</p>}
        <button className="btn btn-ink" type="submit">Send reset link</button>
      </form>
    </AuthShell>
  );
}
