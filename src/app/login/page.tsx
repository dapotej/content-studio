import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { PasswordInput } from "@/components/PasswordInput";
import { addMember, countUsers, createUser, createWorkspace, findUserByEmail, oldestWorkspace } from "@/lib/accounts";
import { legacyPasswordMatches } from "@/lib/auth";
import { PASSWORD_RULE, hashPassword, passwordOk, verifyPassword } from "@/lib/passwords";
import { LIMITS, clearAttempts, clientIp, limited, noteAttempt, startSession as signInDevice } from "@/lib/security";

export const dynamic = "force-dynamic";

const safeNext = (n: unknown) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") ? n : "/");

async function startSession(userId: string, next: string) {
  await signInDevice(userId);
  redirect(safeNext(next));
}

async function signIn(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");
  // Slow down password guessing: too many failures for an account, or from one address, pause sign-in.
  const emailKey = `login:email:${email}`;
  const ipKey = `login:ip:${await clientIp()}`;
  if (await limited([[emailKey, LIMITS.loginEmail], [ipKey, LIMITS.loginIp]])) redirect(`/login?error=limit&next=${encodeURIComponent(next)}`);
  const user = email ? await findUserByEmail(email) : null;
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    await noteAttempt(emailKey, ipKey);
    redirect(`/login?error=wrong&next=${encodeURIComponent(next)}`);
  }
  await clearAttempts(emailKey);
  await startSession(user.id, next);
}

/** First run: the owner swaps the old shared password for their own account and keeps the existing workspace. */
async function claim(formData: FormData) {
  "use server";
  if ((await countUsers()) > 0) redirect("/login");
  const g = (k: string) => String(formData.get(k) ?? "").trim();
  const ipKey = `login:ip:${await clientIp()}`;
  if (await limited([[ipKey, LIMITS.loginIp]])) redirect("/login?error=limit");
  if (!(await legacyPasswordMatches(String(formData.get("legacy") ?? "")))) {
    await noteAttempt(ipKey);
    redirect("/login?error=legacy");
  }
  const password = String(formData.get("password") ?? "");
  if (!/^\S+@\S+\.\S+$/.test(g("email"))) redirect("/login?error=email");
  if (!passwordOk(password)) redirect("/login?error=short");
  const user = await createUser(g("email"), g("name"), await hashPassword(password));
  const ws = (await oldestWorkspace()) ?? (await createWorkspace(g("name") || "My workspace"));
  await addMember(ws.id, user.id, "owner");
  await startSession(user.id, "/");
}

const ERRORS: Record<string, string> = {
  wrong: "That email and password don't match. Try again.",
  legacy: "That isn't the current Buzzbite password.",
  email: "Enter a valid email address.",
  short: `Choose a longer password. ${PASSWORD_RULE}`,
  limit: "Too many tries. Wait 15 minutes and try again, or reset your password.",
};

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; next?: string; reset?: string }> }) {
  const { error, next, reset } = await searchParams;
  const firstRun = (await countUsers()) === 0;
  const err = error && <p className="error" role="alert">{ERRORS[error] ?? "Something went wrong. Try again."}</p>;
  if (firstRun) {
    return (
      <AuthShell title="Set up your account" lede="You'll sign in with your email from now on, and keep all your brands and posts.">
        <form action={claim}>
          <label className="field" htmlFor="legacy">Current Buzzbite password<span className="hint">The shared password you use today. Needed once.</span>
            <PasswordInput id="legacy" name="legacy" autoComplete="current-password" required />
          </label>
          <label className="field" htmlFor="name">Your name<input id="name" name="name" type="text" autoComplete="name" required /></label>
          <label className="field" htmlFor="email">Email<input id="email" name="email" type="email" autoComplete="email" required /></label>
          <label className="field" htmlFor="password">New password<span className="hint">{PASSWORD_RULE}</span>
            <PasswordInput id="password" name="password" autoComplete="new-password" minLength={10} required />
          </label>
          {err}
          <button className="btn btn-ink" type="submit">Create my account</button>
        </form>
      </AuthShell>
    );
  }
  const open = process.env.SIGNUPS_OPEN === "true";
  return (
    <AuthShell title="Welcome back" lede="Sign in to see what's planned and what went out."
      footer={open
        ? <>New to Buzzbite? <Link href="/signup">Start your free 14-day trial</Link></>
        : <>New to Buzzbite? It&rsquo;s invite-only for now. <Link href="https://buzzbite.io/#waitlist">Join the waitlist</Link></>}>
      {reset && <p className="notice" role="status">Password changed. Sign in with your new password.</p>}
      <form action={signIn}>
        <input type="hidden" name="next" value={safeNext(next)} />
        <label className="field" htmlFor="email">Email<input id="email" name="email" type="email" autoComplete="email" required autoFocus /></label>
        <label className="field" htmlFor="password">
          <span className="row" style={{ justifyContent: "space-between" }}>Password<Link href="/forgot" className="small" style={{ fontWeight: 600 }}>Forgot it?</Link></span>
          <PasswordInput id="password" name="password" autoComplete="current-password" required />
        </label>
        {err}
        <button className="btn btn-ink" type="submit">Sign in</button>
      </form>
    </AuthShell>
  );
}
