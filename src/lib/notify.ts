import "server-only";
import { neon } from "@neondatabase/serverless";
import { appUrl } from "./alerts";
import { emailConfigured, sendEmail } from "./email";

// Notifications: what happened while you were away. Shown under the bell in the app and sent
// as one email a day (when email is set up). Written by webhooks and the daily check too, so
// not scoped by session; reads are by workspace.

function client() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export type NoteKind = "posted" | "failed" | "review" | "gap";
export type Note = { id: string; brand_id: string | null; brand_name: string | null; post_id: string | null; kind: NoteKind; title: string; body: string; link: string; created_at: string; read_at: string | null };

/** Records a notification for the brand's workspace. With a dedupe key, only the first one is kept. */
export async function notify(brandId: string, n: { postId?: string | null; kind: NoteKind; title: string; body?: string; link?: string; dedupe?: string }): Promise<void> {
  try {
    await client()`
      insert into notifications (workspace_id, brand_id, post_id, kind, title, body, link, dedupe)
      select workspace_id, id, ${n.postId ?? null}, ${n.kind}, ${n.title.slice(0, 200)}, ${(n.body ?? "").slice(0, 600)}, ${n.link ?? ""}, ${n.dedupe ?? null}
      from brands where id = ${brandId}
      on conflict (workspace_id, dedupe) where dedupe is not null do nothing`;
  } catch (e) {
    console.error("could not save notification", e); // never let a notification break the work it reports on
  }
}

/** A notification about the workspace itself (billing), emailed to its members straight away. */
export async function notifyWorkspace(workspaceId: string, n: { kind: NoteKind; title: string; body?: string; link?: string; dedupe?: string }): Promise<void> {
  try {
    const rows = await client()`
      insert into notifications (workspace_id, kind, title, body, link, dedupe)
      values (${workspaceId}, ${n.kind}, ${n.title.slice(0, 200)}, ${(n.body ?? "").slice(0, 600)}, ${n.link ?? ""}, ${n.dedupe ?? null})
      on conflict (workspace_id, dedupe) where dedupe is not null do nothing returning id`;
    if (!rows.length) return; // already told
    const to = (await client()`select u.email from workspace_members m join users u on u.id = m.user_id where m.workspace_id = ${workspaceId}`).map((r) => r.email as string);
    if (to.length && (await sendEmail(to, n.title, `${n.body ?? ""}\n\n${appUrl()}${n.link ?? ""}`))) {
      await client()`update notifications set emailed_at = now() where id = ${rows[0].id as string}`;
    }
  } catch (e) {
    console.error("could not notify workspace", e);
  }
}

export async function listNotes(workspaceId: string, limit = 60): Promise<Note[]> {
  const rows = await client()`
    select n.*, b.name as brand_name from notifications n left join brands b on b.id = n.brand_id
    where n.workspace_id = ${workspaceId} order by n.created_at desc limit ${limit}`;
  return rows.map((r) => ({
    id: r.id as string, brand_id: (r.brand_id as string) ?? null, brand_name: (r.brand_name as string) ?? null, post_id: (r.post_id as string) ?? null,
    kind: r.kind as NoteKind, title: r.title as string, body: r.body as string, link: r.link as string,
    created_at: iso(r.created_at), read_at: r.read_at ? iso(r.read_at) : null,
  }));
}

export async function unreadCount(workspaceId: string): Promise<number> {
  const rows = await client()`select count(*)::int as n from notifications where workspace_id = ${workspaceId} and read_at is null`;
  return Number((rows[0] as { n: number }).n);
}

export async function markAllRead(workspaceId: string): Promise<void> {
  await client()`update notifications set read_at = now() where workspace_id = ${workspaceId} and read_at is null`;
}

/** Once a day: one email per workspace with everything new that hasn't been seen or emailed. */
export async function sendDigests(): Promise<number> {
  if (!emailConfigured()) return 0;
  const rows = await client()`
    select n.id, n.workspace_id, n.title, n.body, n.link, b.name as brand_name from notifications n left join brands b on b.id = n.brand_id
    where n.read_at is null and n.emailed_at is null and n.created_at > now() - interval '2 days' order by n.created_at`;
  const byWs = new Map<string, typeof rows>();
  for (const r of rows) byWs.set(r.workspace_id as string, [...(byWs.get(r.workspace_id as string) ?? []), r]);
  let sent = 0;
  for (const [ws, notes] of byWs) {
    const to = (await client()`select u.email from workspace_members m join users u on u.id = m.user_id where m.workspace_id = ${ws}`).map((r) => r.email as string);
    if (!to.length) continue;
    const lines = notes.map((n) => `• ${n.brand_name ? `${n.brand_name}: ` : ""}${n.title}${n.body ? `\n  ${n.body}` : ""}${n.link ? `\n  ${n.link.startsWith("http") ? n.link : appUrl() + n.link}` : ""}`);
    const ok = await sendEmail(to, notes.length === 1 ? `Buzzbite: ${notes[0].title}` : `Buzzbite: ${notes.length} updates`,
      `Here's what happened on Buzzbite:\n\n${lines.join("\n\n")}\n\nOpen Buzzbite: ${appUrl()}/notifications`);
    if (ok) {
      await client()`update notifications set emailed_at = now() where id = any(${notes.map((n) => n.id as string)})`;
      sent++;
    }
  }
  return sent;
}
