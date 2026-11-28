import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { AuthShell } from "@/components/AuthShell";
import { PasswordInput } from "@/components/PasswordInput";
import { countries, isCountry } from "@/lib/countries";
import { addMember, createUser, createWorkspace, findUserByEmail, getInvite, getWorkspace, useInvite, type Invite } from "@/lib/accounts";
import { startSession } from "@/lib/security";
import { PASSWORD_RULE, hashPassword, passwordOk, verifyPassword } from "@/lib/passwords";

export const dynamic = "force-dynamic";

const signupsOpen = () => process.env.SIGNUPS_OPEN === "true";

async function validInvite(token: string): Promise<Invite | null> {
  if (!token) return null;
  const inv = await getInvite(token);
  return inv && !inv.used_at && new Date(inv.expires_at).getTime() > Date.now() ? inv : null;
}

async function signUp(formData: FormData) {
  "use server";
  const g = (k: string) => String(formData.get(k) ?? "").trim();
  const token = g("invite");
  const back = (code: string) => redirect(`/signup?invite=${encodeURIComponent(token)}&error=${code}`);
  const invite = await validInvite(token);
  if (!invite && !signupsOpen()) back("invite");
  const email = (invite?.email || g("email")).toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!/^\S+@\S+\.\S+$/.test(email)) back("email");

  const existing = await findUserByEmail(email);
  let userId: string;
  if (existing) {
    // Joining a team with an account you already have: confirm it's you.
    if (invite?.kind !== "team" || !(await verifyPassword(password, existing.password_hash))) back("exists");
    userId = existing!.id;
  } else {
    if (!passwordOk(password)) back("short");
    userId = (await createUser(email, g("name"), await hashPassword(password))).id;
  }

  if (invite?.kind === "team" && invite.workspace_id) {
    await addMember(invite.workspace_id, userId, "member");
  } else {
    const ws = await createWorkspace(g("business") || g("name") || "My workspace", isCountry(g("country")) ? g("country").toUpperCase() : null);
    await addMember(ws.id, userId, "owner");
  }
  if (invite) await useInvite(invite.token);
  await startSession(userId);
  redirect("/");
}

const ERRORS: Record<string, string> = {
  invite: "This invite link has expired or was already used. Ask for a new one.",
  email: "Enter a valid email address.",
  short: `Choose a longer password. ${PASSWORD_RULE}`,
  exists: "There's already an account with that email. Sign in instead, or use your existing password to join this team.",
};

export default async function SignUp({ searchParams }: { searchParams: Promise<{ invite?: string; error?: string }> }) {
  const { invite: token = "", error } = await searchParams;
  const invite = await validInvite(token);
  const team = invite?.kind === "team" && invite.workspace_id ? await getWorkspace(invite.workspace_id) : null;

  if (!invite && !signupsOpen()) {
    return (
      <AuthShell title={token ? "This invite link doesn't work" : "Buzzbite is invite-only for now"}
        lede={token ? "It has expired or was already used. Ask the person who sent it for a new one." : "We're opening to a small group first."}>
        <div className="row"><a className="btn btn-ink" href="https://buzzbite.io/#waitlist">Join the waitlist</a><Link className="btn" href="/login">Sign in</Link></div>
      </AuthShell>
    );
  }

  const ipCountry = (await headers()).get("x-vercel-ip-country") ?? "";
  return (
    <AuthShell
      title={team ? `Join ${team.name}` : "Start your free trial"}
      lede={team ? "Create your account to work on this team's social media." : "Set up your brand in minutes. Your first posts are ready to approve today."}
      footer={<>Already have an account? <Link href="/login">Sign in</Link></>}>
      {!team && <ul className="auth-perks"><li>14 days free</li><li>No card needed</li><li>Cancel any time</li></ul>}
      <form action={signUp}>
        <input type="hidden" name="invite" value={token} />
        <div className="auth-row">
          <label className="field" htmlFor="name">Your name<input id="name" name="name" type="text" autoComplete="name" required autoFocus /></label>
          {!team && <label className="field" htmlFor="business">Business name<input id="business" name="business" type="text" autoComplete="organization" /></label>}
        </div>
        <label className="field" htmlFor="email">Work email
          <input id="email" name="email" type="email" autoComplete="email" required defaultValue={invite?.email || ""} readOnly={!!invite?.email} />
        </label>
        <label className="field" htmlFor="password">Password<span className="hint">{PASSWORD_RULE}</span>
          <PasswordInput id="password" name="password" autoComplete="new-password" minLength={10} required />
        </label>
        {!team && (
          <label className="field" htmlFor="country">Country<span className="hint">Sets your currency and how you pay later.</span>
            <select id="country" name="country" defaultValue={isCountry(ipCountry) ? ipCountry.toUpperCase() : ""} required>
              <option value="" disabled>Choose your country</option>
              {countries().map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </label>
        )}
        {error && <p className="error" role="alert">{ERRORS[error] ?? "Something went wrong. Try again."}</p>}
        <button className="btn btn-ink" type="submit">{team ? "Join the team" : "Create my account"}</button>
      </form>
    </AuthShell>
  );
}
