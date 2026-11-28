import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Wordmark } from "@/components/Logo";
import { BillingPlans, CopyLink } from "@/components/Billing";
import {
  createInvite, endAllSessions, findUserByEmail, getSession, getUser, listMembers, listOpenInvites, removeMember, renameWorkspace,
  requireSession, revokeInvite, setPassword, signupInviteFor, updateUser,
} from "@/lib/accounts";
import { blockedReason, usageFor } from "@/lib/limits";
import { PASSWORD_RULE, hashPassword, newToken, passwordOk, verifyPassword } from "@/lib/passwords";
import { PAID_PLANS, PLANS, isUnlimited } from "@/lib/plans";
import { paystackConfirm, paystackReady, stripeReady } from "@/lib/payments";
import { RESET_LINK_HOURS, createResetToken, startSession } from "@/lib/security";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings · Buzzbite" };

const back = (q: string) => redirect(`/settings?${q}`);

async function saveAccount(formData: FormData) {
  "use server";
  const s = await requireSession();
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) back("msg=bad-email#account");
  const other = await findUserByEmail(email);
  if (other && other.id !== s.user.id) back("msg=email-taken#account");
  // Changing the sign-in email needs the password, so a borrowed session can't take the account.
  if (email !== s.user.email) {
    const me = await getUser(s.user.id);
    if (!me || !(await verifyPassword(String(formData.get("current") ?? ""), me.password_hash))) back("msg=email-password#account");
  }
  await updateUser(s.user.id, { name, email });
  back("msg=saved#account");
}

async function changePassword(formData: FormData) {
  "use server";
  const s = await requireSession();
  const me = await getUser(s.user.id);
  const next = String(formData.get("next") ?? "");
  if (!me || !(await verifyPassword(String(formData.get("current") ?? ""), me.password_hash))) back("msg=wrong-password#account");
  if (!passwordOk(next)) back("msg=short#account");
  // A new password signs out every other device; this one stays signed in.
  await setPassword(s.user.id, await hashPassword(next));
  await startSession(s.user.id);
  back("msg=password#account");
}

async function signOutEverywhere() {
  "use server";
  const s = await requireSession();
  await endAllSessions(s.user.id);
  await startSession(s.user.id);
  back("msg=signed-out#account");
}

/** Owner: a one-time link for a teammate who has forgotten their password. */
async function resetLink(formData: FormData) {
  "use server";
  const s = await requireSession();
  if (s.role !== "owner") back("msg=owner-only#team");
  const member = (await listMembers(s.workspace.id)).find((m) => m.id === String(formData.get("user")) && m.role !== "owner");
  if (!member) back("msg=owner-only#team");
  const token = await createResetToken(member!.id);
  back(`reset=${token}&for=${encodeURIComponent(member!.email)}#team`);
}

async function saveWorkspace(formData: FormData) {
  "use server";
  const s = await requireSession();
  if (s.role !== "owner") back("msg=owner-only#team");
  const name = String(formData.get("workspace") ?? "").trim().slice(0, 120);
  if (name) await renameWorkspace(s.workspace.id, name);
  back("msg=saved#team");
}

async function inviteTeammate(formData: FormData) {
  "use server";
  const s = await requireSession();
  if (s.role !== "owner") back("msg=owner-only#team");
  const token = newToken();
  await createInvite({ token, kind: "team", workspaceId: s.workspace.id, email: String(formData.get("email") ?? ""), createdBy: s.user.id, days: 14 });
  back(`invite=${token}#team`);
}

async function revoke(formData: FormData) {
  "use server";
  const s = await requireSession();
  if (s.role === "owner") await revokeInvite(s.workspace.id, String(formData.get("token")));
  revalidatePath("/settings");
}

async function remove(formData: FormData) {
  "use server";
  const s = await requireSession();
  if (s.role === "owner") await removeMember(s.workspace.id, String(formData.get("user")));
  revalidatePath("/settings");
}

/** Buzzbite team only: an early-access link for someone on the waitlist (a new workspace with a trial). */
async function earlyAccess(formData: FormData) {
  "use server";
  const s = await requireSession();
  if (s.workspace.plan !== "internal") back("msg=owner-only#early");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) back("msg=bad-email#early");
  const existing = await signupInviteFor(email);
  const token = existing?.token ?? newToken();
  if (!existing) await createInvite({ token, kind: "signup", workspaceId: null, email, createdBy: s.user.id, days: 30 });
  back(`signup=${token}&for=${encodeURIComponent(email)}#early`);
}

const MSG: Record<string, [string, boolean]> = {
  saved: ["Saved.", true], password: ["Password changed.", true], "bad-email": ["Enter a valid email address.", false],
  "email-taken": ["Another account uses that email.", false], "wrong-password": ["Your current password isn't right.", false],
  short: [`Choose a longer password. ${PASSWORD_RULE}`, false],
  "email-password": ["Enter your current password to change your email.", false],
  "signed-out": ["Signed out of every other device.", true], "owner-only": ["Only the workspace owner can do that.", false],
};

export default async function Settings({ searchParams }: {
  searchParams: Promise<{ msg?: string; invite?: string; reset?: string; signup?: string; for?: string; billing?: string; reference?: string }>;
}) {
  const q = await searchParams;
  let s = await getSession();
  if (!s) redirect("/login?next=/settings");
  if (q.billing === "paystack" && q.reference && s.role === "owner") {
    if (await paystackConfirm(q.reference, s.workspace.id)) s = (await getSession())!;
  }
  const host = (await headers()).get("host") ?? "app.buzzbite.io";
  const origin = `${host.startsWith("localhost") ? "http" : "https"}://${host}`;
  const [members, invites, usage] = await Promise.all([listMembers(s.workspace.id), s.role === "owner" ? listOpenInvites(s.workspace.id) : [], usageFor(s.workspace.id)]);
  const plan = PLANS[s.workspace.plan];
  const owner = s.role === "owner";
  const internal = s.workspace.plan === "internal";
  const msg = q.msg ? MSG[q.msg] : null;
  const trialDays = s.workspace.plan === "trial" && s.workspace.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(s.workspace.trial_ends_at).getTime() - Date.now()) / 86400_000)) : null;
  const blocked = blockedReason(s);
  const meter = (label: string, used: number, max: number) => (
    <div className="meter" key={label}>
      <div className="row" style={{ justifyContent: "space-between" }}><span>{label}</span><strong>{used}{isUnlimited(max) ? "" : ` of ${max}`}</strong></div>
      {!isUnlimited(max) && <div className="progress"><div style={{ width: `${Math.min(100, (used / max) * 100)}%` }} /></div>}
    </div>
  );

  return (
    <main className="wrap settings" style={{ paddingTop: 24, paddingBottom: 64, paddingInline: 16, maxWidth: 860 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Link href="/" aria-label="Back to Buzzbite"><Wordmark height={24} /></Link>
        <Link className="btn btn-ghost" href="/">← Back</Link>
      </div>
      <h1 className="title">Settings</h1>
      {msg && <p className={msg[1] ? "notice" : "error"} role="status">{msg[0]}</p>}

      <section className="card stack" id="account">
        <h2>Your account</h2>
        <form action={saveAccount} className="stack">
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "1 1 220px" }}>Name<input name="name" type="text" defaultValue={s.user.name} autoComplete="name" /></label>
            <label className="field" style={{ flex: "1 1 260px" }}>Email<input name="email" type="email" defaultValue={s.user.email} autoComplete="email" required /></label>
          </div>
          <label className="field" style={{ maxWidth: 320 }}>Current password<span className="hint">Only needed to change your email.</span><input name="current" type="password" autoComplete="current-password" /></label>
          <button className="btn" type="submit" style={{ alignSelf: "flex-start" }}>Save</button>
        </form>
        <form action={changePassword} className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "1 1 220px" }}>Current password<input name="current" type="password" autoComplete="current-password" required /></label>
            <label className="field" style={{ flex: "1 1 220px" }}>New password<span className="hint">{PASSWORD_RULE}</span><input name="next" type="password" autoComplete="new-password" minLength={10} required /></label>
          </div>
          <button className="btn" type="submit" style={{ alignSelf: "flex-start" }}>Change password</button>
        </form>
        <form action={signOutEverywhere} className="row" style={{ borderTop: "1px solid var(--line)", paddingTop: 14, justifyContent: "space-between" }}>
          <span className="small muted">Signed in on a shared or lost device? Sign out everywhere except here.</span>
          <button className="btn" type="submit">Sign out other devices</button>
        </form>
      </section>

      <section className="card stack" id="team">
        <h2>Workspace and team</h2>
        <form action={saveWorkspace} className="row" style={{ alignItems: "flex-end" }}>
          <label className="field" style={{ flex: "1 1 260px" }}>Workspace name<input name="workspace" type="text" defaultValue={s.workspace.name} disabled={!owner} /></label>
          {owner && <button className="btn" type="submit">Save</button>}
        </form>
        <ul className="members">
          {members.map((m) => (
            <li key={m.id}>
              <span className="bdot" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>{(m.name || m.email).slice(0, 1).toUpperCase()}</span>
              <span className="who"><strong>{m.name || m.email}</strong><span className="small muted">{m.email} · {m.role === "owner" ? "Owner" : "Member"}</span></span>
              {owner && m.role !== "owner" && (
                <span className="row" style={{ gap: 4 }}>
                  <form action={resetLink}><input type="hidden" name="user" value={m.id} /><button className="btn btn-ghost" type="submit">Password reset link</button></form>
                  <form action={remove}><input type="hidden" name="user" value={m.id} /><button className="btn btn-ghost btn-danger" type="submit">Remove</button></form>
                </span>
              )}
            </li>
          ))}
        </ul>
        {owner && (
          <>
            {q.reset && <CopyLink label={`Password reset link for ${q.for ?? "your teammate"} (works once, for ${RESET_LINK_HOURS} hours). Send it to them directly:`} url={`${origin}/reset?token=${q.reset}`} />}
            {q.invite && <CopyLink label="Invite link (works once, for 14 days). Send it to your teammate:" url={`${origin}/signup?invite=${q.invite}`} />}
            <form action={inviteTeammate} className="row" style={{ alignItems: "flex-end" }}>
              <label className="field" style={{ flex: "1 1 260px" }}>Invite a teammate<span className="hint">Optional: their email, so only they can use the link.</span><input name="email" type="email" placeholder="name@company.com" /></label>
              <button className="btn btn-ink" type="submit">Create invite link</button>
            </form>
            {invites.length > 0 && (
              <ul className="members">
                {invites.map((i) => (
                  <li key={i.token}>
                    <span className="who"><strong>{i.email || "Anyone with the link"}</strong><span className="small muted">Invite open until {new Date(i.expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span></span>
                    <form action={revoke}><input type="hidden" name="token" value={i.token} /><button className="btn btn-ghost" type="submit">Cancel invite</button></form>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="card stack" id="billing">
        <h2>Plan and billing</h2>
        {q.billing === "success" && <p className="notice" role="status">Thanks. Your plan is being activated; it can take a minute to show here.</p>}
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <strong style={{ fontSize: 20 }}>{plan.name}</strong>
            <p className="small muted">
              {internal ? "No limits, no billing." : s.workspace.plan === "trial" ? (trialDays ? `${trialDays} day${trialDays === 1 ? "" : "s"} left in your free trial.` : "Your free trial has ended.")
                : s.workspace.plan_status === "active" ? (s.workspace.billing.cancelAtPeriodEnd
                  ? `Cancelled. Your plan stays active until ${s.workspace.billing.currentPeriodEnd ? new Date(s.workspace.billing.currentPeriodEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "the end of this period"}.`
                  : `Active${s.workspace.billing.currentPeriodEnd ? `, renews ${new Date(s.workspace.billing.currentPeriodEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}.`)
                : s.workspace.plan_status === "past_due" ? "Payment failed. Update your payment details." : "Cancelled."}
            </p>
          </div>
          <span className={`chip ${blocked ? "chip-wait" : "chip-ok"}`}>{blocked ? "Action needed" : internal ? "Internal" : s.workspace.plan === "trial" ? "Trial" : s.workspace.plan_status}</span>
        </div>
        <div className="meters">
          {meter("Posts this month", usage.posts, plan.posts)}
          {meter("Videos this month", usage.videos, plan.videos)}
          {meter("Brands", usage.brands, plan.brands)}
        </div>
        {!internal && (
          <BillingPlans
            current={s.workspace.plan} status={s.workspace.plan_status} owner={owner} provider={s.workspace.billing.provider ?? null}
            plans={PAID_PLANS.map((id) => ({ id, ...PLANS[id] }))} stripe={stripeReady()} paystack={paystackReady()}
          />
        )}
      </section>

      {internal && (
        <section className="card stack" id="early">
          <h2>Early access invites</h2>
          <p className="small muted">Buzzbite is invite-only. Create a sign-up link for someone on the waitlist: they get their own workspace with a {14}-day trial. Waitlist emails are on <Link href="/leads">Website sign-ups</Link>.</p>
          {q.signup && <CopyLink label={`Sign-up link for ${q.for ?? "them"} (works once, for 30 days):`} url={`${origin}/signup?invite=${q.signup}`} />}
          <form action={earlyAccess} className="row" style={{ alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "1 1 260px" }}>Their email<input name="email" type="email" required placeholder="name@company.com" /></label>
            <button className="btn btn-ink" type="submit">Create sign-up link</button>
          </form>
        </section>
      )}
    </main>
  );
}
