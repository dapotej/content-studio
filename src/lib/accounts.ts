import "server-only";
import { neon } from "@neondatabase/serverless";
import { cookies } from "next/headers";
import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
import { SESSION_COOKIE, readSession } from "./auth";
import { PLANS, TRIAL_DAYS, type Plan, type PlanId, type PlanStatus } from "./plans";

function client() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}
type Row = Record<string, unknown>;
const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

export class AuthError extends Error {}

export type User = { id: string; email: string; name: string; created_at: string };
export type Billing = {
  provider?: "stripe" | "paystack";
  customerId?: string;          // Stripe customer
  subscriptionId?: string;      // Stripe subscription or Paystack subscription code
  emailToken?: string;          // Paystack, to manage the subscription
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;  // Stripe: cancelled, still active until currentPeriodEnd
  lastEventAt?: number;         // Stripe: created time of the newest event applied, so older ones are ignored
};
export type Workspace = {
  id: string; name: string; plan: PlanId; plan_status: PlanStatus; trial_ends_at: string | null; billing: Billing; created_at: string;
  /** ISO country code: decides how the workspace pays. */
  country: string | null;
};
export type Member = User & { role: "owner" | "member" };
export type Invite = { token: string; kind: "signup" | "team"; workspace_id: string | null; email: string; expires_at: string; used_at: string | null };

const toUser = (r: Row): User => ({ id: r.id as string, email: r.email as string, name: (r.name as string) ?? "", created_at: iso(r.created_at)! });
const toWorkspace = (r: Row): Workspace => ({
  id: r.id as string, name: r.name as string, plan: (r.plan as PlanId) ?? "trial", plan_status: (r.plan_status as PlanStatus) ?? "trialing",
  trial_ends_at: iso(r.trial_ends_at), billing: (r.billing as Billing) ?? {}, created_at: iso(r.created_at)!,
  country: (r.country as string) ?? null,
});

// ---------- users ----------
export async function countUsers(): Promise<number> {
  return Number(((await client()`select count(*)::int as n from users`)[0] as { n: number }).n);
}
export async function findUserByEmail(email: string): Promise<(User & { password_hash: string }) | null> {
  const rows = await client()`select * from users where email = ${email.trim().toLowerCase()}`;
  return rows[0] ? { ...toUser(rows[0]), password_hash: rows[0].password_hash as string } : null;
}
export async function getUser(id: string): Promise<(User & { password_hash: string; session_version: number }) | null> {
  const rows = await client()`select * from users where id = ${id}`;
  return rows[0] ? { ...toUser(rows[0]), password_hash: rows[0].password_hash as string, session_version: Number(rows[0].session_version ?? 0) } : null;
}
/** Sets a new password and ends every session the user has. Returns the new session version. */
export async function setPassword(id: string, passwordHash: string): Promise<number> {
  const rows = await client()`update users set password_hash = ${passwordHash}, session_version = session_version + 1 where id = ${id} returning session_version`;
  return Number((rows[0] as { session_version: number }).session_version);
}
/** Ends every session the user has (sign out everywhere). Returns the new session version. */
export async function endAllSessions(id: string): Promise<number> {
  const rows = await client()`update users set session_version = session_version + 1 where id = ${id} returning session_version`;
  return Number((rows[0] as { session_version: number }).session_version);
}
export async function createUser(email: string, name: string, passwordHash: string): Promise<User> {
  const rows = await client()`insert into users (email, name, password_hash) values (${email.trim().toLowerCase()}, ${name.trim()}, ${passwordHash}) returning *`;
  return toUser(rows[0]);
}
export async function updateUser(id: string, patch: { name?: string; email?: string; password_hash?: string }): Promise<void> {
  const cur = await getUser(id);
  if (!cur) return;
  await client()`update users set name = ${patch.name ?? cur.name}, email = ${(patch.email ?? cur.email).toLowerCase()},
    password_hash = ${patch.password_hash ?? cur.password_hash} where id = ${id}`;
}

// ---------- workspaces ----------
export async function createWorkspace(name: string, country: string | null = null): Promise<Workspace> {
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString();
  const rows = await client()`insert into workspaces (name, plan, plan_status, trial_ends_at, country) values (${name}, 'trial', 'trialing', ${trialEnds}, ${country}) returning *`;
  return toWorkspace(rows[0]);
}
export async function getWorkspace(id: string): Promise<Workspace | null> {
  const rows = await client()`select * from workspaces where id = ${id}`;
  return rows[0] ? toWorkspace(rows[0]) : null;
}
export async function oldestWorkspace(): Promise<Workspace | null> {
  const rows = await client()`select * from workspaces order by created_at limit 1`;
  return rows[0] ? toWorkspace(rows[0]) : null;
}
export async function setWorkspaceCountry(id: string, country: string): Promise<void> {
  await client()`update workspaces set country = ${country.toUpperCase().slice(0, 2)} where id = ${id}`;
}
export async function renameWorkspace(id: string, name: string): Promise<void> {
  await client()`update workspaces set name = ${name} where id = ${id}`;
}
export async function setWorkspacePlan(id: string, patch: { plan?: PlanId; plan_status?: PlanStatus; billing?: Billing }): Promise<void> {
  const cur = await getWorkspace(id);
  if (!cur) return;
  await client()`update workspaces set plan = ${patch.plan ?? cur.plan}, plan_status = ${patch.plan_status ?? cur.plan_status},
    billing = ${JSON.stringify({ ...cur.billing, ...(patch.billing ?? {}) })}::jsonb where id = ${id}`;
}
export async function findWorkspaceByBilling(key: "customerId" | "subscriptionId", value: string): Promise<Workspace | null> {
  const rows = await client()`select * from workspaces where billing->>${key} = ${value} limit 1`;
  return rows[0] ? toWorkspace(rows[0]) : null;
}

// ---------- members ----------
export async function addMember(workspaceId: string, userId: string, role: "owner" | "member"): Promise<void> {
  await client()`insert into workspace_members (workspace_id, user_id, role) values (${workspaceId}, ${userId}, ${role}) on conflict do nothing`;
}
export async function listMembers(workspaceId: string): Promise<Member[]> {
  const rows = await client()`select u.*, m.role from workspace_members m join users u on u.id = m.user_id where m.workspace_id = ${workspaceId} order by m.created_at`;
  return rows.map((r) => ({ ...toUser(r), role: r.role as "owner" | "member" }));
}
export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  await client()`delete from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId} and role <> 'owner'`;
}
async function membershipOf(userId: string): Promise<{ workspace_id: string; role: "owner" | "member" } | null> {
  const rows = await client()`select workspace_id, role from workspace_members where user_id = ${userId} order by (role = 'owner') desc, created_at limit 1`;
  return (rows[0] as { workspace_id: string; role: "owner" | "member" }) ?? null;
}

// ---------- invites ----------
export async function createInvite(i: { token: string; kind: "signup" | "team"; workspaceId: string | null; email: string; createdBy: string; days: number }): Promise<void> {
  const expires = new Date(Date.now() + i.days * 86400_000).toISOString();
  await client()`insert into invites (token, kind, workspace_id, email, created_by, expires_at) values (${i.token}, ${i.kind}, ${i.workspaceId}, ${i.email.trim().toLowerCase()}, ${i.createdBy}, ${expires})`;
}
export async function getInvite(token: string): Promise<Invite | null> {
  const rows = await client()`select * from invites where token = ${token}`;
  if (!rows[0]) return null;
  const r = rows[0];
  return { token: r.token as string, kind: r.kind as Invite["kind"], workspace_id: (r.workspace_id as string) ?? null, email: (r.email as string) ?? "", expires_at: iso(r.expires_at)!, used_at: iso(r.used_at) };
}
export async function useInvite(token: string): Promise<void> {
  await client()`update invites set used_at = now() where token = ${token}`;
}
export async function listOpenInvites(workspaceId: string): Promise<Invite[]> {
  const rows = await client()`select * from invites where workspace_id = ${workspaceId} and kind = 'team' and used_at is null and expires_at > now() order by created_at desc`;
  return rows.map((r) => ({ token: r.token as string, kind: "team" as const, workspace_id: workspaceId, email: (r.email as string) ?? "", expires_at: iso(r.expires_at)!, used_at: null }));
}
export async function revokeInvite(workspaceId: string, token: string): Promise<void> {
  await client()`delete from invites where token = ${token} and workspace_id = ${workspaceId}`;
}
export async function signupInviteFor(email: string): Promise<Invite | null> {
  const rows = await client()`select * from invites where kind = 'signup' and email = ${email.trim().toLowerCase()} and used_at is null and expires_at > now() order by created_at desc limit 1`;
  if (!rows[0]) return null;
  return { token: rows[0].token as string, kind: "signup", workspace_id: null, email: rows[0].email as string, expires_at: iso(rows[0].expires_at)!, used_at: null };
}

// ---------- the current session ----------
export type Session = { user: User; workspace: Workspace; role: "owner" | "member"; plan: Plan };

/** The signed-in user and their workspace, or null. Memoised per request. */
export const getSession = cache(async (): Promise<Session | null> => {
  const cookie = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!cookie) return null;
  const userId = cookie.userId;
  const user = await getUser(userId);
  if (!user || user.session_version !== cookie.version) return null;
  const m = await membershipOf(userId);
  if (!m) return null;
  const workspace = await getWorkspace(m.workspace_id);
  if (!workspace) return null;
  const { password_hash: _drop, session_version: _v, ...plain } = user;
  return { user: plain, workspace, role: m.role, plan: PLANS[workspace.plan] ?? PLANS.trial };
});

// Background work (webhooks, the daily check) runs for one workspace with no one signed in.
// Every scoped query and plan limit then applies to that workspace, as for a signed-in owner.
const systemContext = new AsyncLocalStorage<Session>();
export const SYSTEM_USER: User = { id: "00000000-0000-0000-0000-000000000000", email: "system@buzzbite.io", name: "Buzzbite", created_at: new Date(0).toISOString() };

export async function runAsWorkspace<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new AuthError("No such workspace.");
  return systemContext.run({ user: SYSTEM_USER, workspace, role: "owner", plan: PLANS[workspace.plan] ?? PLANS.trial }, fn);
}
export const inSystemContext = () => systemContext.getStore() !== undefined;

export async function requireSession(): Promise<Session> {
  const system = systemContext.getStore();
  if (system) return system;
  const s = await getSession();
  if (!s) throw new AuthError("Sign in first.");
  return s;
}
