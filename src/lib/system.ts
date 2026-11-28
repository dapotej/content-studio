import "server-only";
import { neon } from "@neondatabase/serverless";
import { runAsWorkspace } from "./accounts";
import { signValue } from "./auth";
import { getBrand, getPost } from "./db";
import { advance } from "./pipeline";
import { syncBrand, syncPost } from "./publish";
import { sendDigests, notify } from "./notify";
import { syncResults } from "./results";

// Work that runs with no one signed in: fal and Zernio webhooks, and the daily check.
// Lookups here cross workspaces, so each piece of work then runs inside its own workspace.

function client() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}
/** The secret Zernio signs webhooks with. Derived from AUTH_SECRET, so there is nothing extra to store. */
export const zernioWebhookSecret = () => signValue("zernio-webhook");

type Owner = { brand_id: string; workspace_id: string };

export async function ownerOfFalRequest(requestId: string): Promise<Owner | null> {
  const rows = await client()`select m.brand_id, b.workspace_id from media m join brands b on b.id = m.brand_id where m.fal_request_id = ${requestId} limit 1`;
  return (rows[0] as Owner) ?? null;
}

export async function ownerOfPost(postId: string): Promise<(Owner & { post_id: string }) | null> {
  const rows = await client()`select p.id as post_id, p.brand_id, b.workspace_id from posts p join brands b on b.id = p.brand_id where p.id = ${postId} limit 1`;
  return (rows[0] as Owner & { post_id: string }) ?? null;
}

export async function ownerOfZernioPost(zernioId: string): Promise<(Owner & { post_id: string }) | null> {
  const rows = await client()`select p.id as post_id, p.brand_id, b.workspace_id from posts p join brands b on b.id = p.brand_id where p.publishing->>'zernioId' = ${zernioId} limit 1`;
  return (rows[0] as Owner & { post_id: string }) ?? null;
}

/** Moves a brand's finished photos and clips on to review. */
export async function advanceBrand(o: Owner): Promise<{ pending: number }> {
  return runAsWorkspace(o.workspace_id, async () => {
    const brand = await getBrand(o.brand_id);
    return brand ? advance(brand) : { pending: 0 };
  });
}

/** Reads one post's result from the posting service. */
export async function syncOne(o: Owner & { post_id: string }): Promise<void> {
  await runAsWorkspace(o.workspace_id, async () => {
    const post = await getPost(o.post_id);
    if (post) await syncPost(post);
  });
}

/** The daily safety net: anything a webhook missed is picked up here. */
export async function dailyCheck(): Promise<{ brands: number; pending: number; synced: number; failed: number }> {
  const rows = (await client()`
    select distinct b.id as brand_id, b.workspace_id from brands b
    where exists (select 1 from media m where m.brand_id = b.id and m.status = 'pending')
       or exists (select 1 from posts p where p.brand_id = b.id and p.publishing->>'zernioId' is not null and p.publishing->>'state' in ('scheduled', 'publishing'))
  `) as Owner[];
  let pending = 0, synced = 0, failed = 0;
  for (const o of rows) {
    try {
      pending += (await advanceBrand(o)).pending;
      synced += await runAsWorkspace(o.workspace_id, () => syncBrand(o.brand_id));
    } catch (e) {
      failed++;
      console.error("daily check failed for brand", o.brand_id, e);
    }
  }
  // Tomorrow is a posting day with nothing approved: say so while there's still time.
  const brands = (await client()`select id, name, settings, social from brands where jsonb_array_length(coalesce(social->'accounts', '[]'::jsonb)) > 0`) as { id: string; name: string; settings: { days?: number[]; tz?: string }; social: unknown }[];
  for (const b of brands) {
    const tz = b.settings.tz || "Africa/Lagos";
    const tomorrow = new Date(Date.now() + 86400_000).toLocaleDateString("sv-SE", { timeZone: tz });
    const weekday = (new Date(tomorrow + "T00:00:00Z").getUTCDay() + 6) % 7;
    if (!(b.settings.days ?? [0, 2, 4]).includes(weekday)) continue;
    const posts = (await client()`select status from posts where brand_id = ${b.id} and publish_on = ${tomorrow}`) as { status: string }[];
    if (posts.some((p) => p.status === "approved" || p.status === "posted")) continue;
    const waiting = posts.some((p) => p.status === "review" || p.status === "making");
    await notify(b.id, {
      kind: "gap", dedupe: `gap:${b.id}:${tomorrow}`,
      title: waiting ? "Tomorrow's post is waiting for your approval" : "Nothing planned for tomorrow",
      body: waiting ? "Approve it today so it goes out on time." : "Tomorrow is a posting day with no post. Create one, or fill the calendar.",
      link: waiting ? `/b/${b.id}/review` : `/b/${b.id}`,
    });
  }
  await sendDigests();

  // Results: read the latest numbers for every brand with connected accounts.
  const social = (await client()`select id as brand_id, workspace_id from brands where social->>'profileId' is not null`) as Owner[];
  for (const o of social) {
    try {
      await runAsWorkspace(o.workspace_id, async () => {
        const brand = await getBrand(o.brand_id);
        if (brand) await syncResults(brand, { force: true });
      });
    } catch (e) {
      console.error("results sync failed for brand", o.brand_id, e);
    }
  }
  // Jobs that fal never finished: after a day, give up so the post can be retried.
  await client()`
    with stale as (update media set status = 'failed', error = 'The generation did not finish. Try again.'
      where status = 'pending' and created_at < now() - interval '1 day' returning post_id)
    update posts set status = 'review', issue = 'A photo or clip did not finish. Use "Try again" to make it again.', updated_at = now()
    where id in (select post_id from stale) and status = 'making'`;
  return { brands: rows.length, pending, synced, failed };
}

export type Health = {
  stuck: { id: string; title: string; brand: string; workspace: string; since: string }[];
  overdue: { id: string; title: string; brand: string; workspace: string; publish_on: string; state: string }[];
  failedMedia7d: number;
  openAlerts: number;
};

/** For the internal team: what needs a look across every workspace. */
export async function health(): Promise<Health> {
  const sql = client();
  const [stuck, overdue, failed, alerts] = await Promise.all([
    sql`select p.id, p.title, b.name as brand, w.name as workspace, p.updated_at as since from posts p join brands b on b.id = p.brand_id join workspaces w on w.id = b.workspace_id
        where p.status = 'making' and p.updated_at < now() - interval '1 hour' order by p.updated_at limit 50`,
    sql`select p.id, p.title, b.name as brand, w.name as workspace, p.publish_on, p.publishing->>'state' as state from posts p join brands b on b.id = p.brand_id join workspaces w on w.id = b.workspace_id
        where p.publishing->>'state' in ('scheduled', 'publishing') and p.publish_on < current_date order by p.publish_on limit 50`,
    sql`select count(*)::int as n from media where status = 'failed' and created_at > now() - interval '7 days'`,
    sql`select count(*)::int as n from alerts where resolved_at is null`,
  ]);
  const d = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return {
    stuck: stuck.map((r) => ({ id: r.id as string, title: r.title as string, brand: r.brand as string, workspace: r.workspace as string, since: d(r.since) })),
    overdue: overdue.map((r) => ({ id: r.id as string, title: r.title as string, brand: r.brand as string, workspace: r.workspace as string, publish_on: d(r.publish_on).slice(0, 10), state: r.state as string })),
    failedMedia7d: Number((failed[0] as { n: number }).n),
    openAlerts: Number((alerts[0] as { n: number }).n),
  };
}
