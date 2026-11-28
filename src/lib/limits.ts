import "server-only";
import { neon } from "@neondatabase/serverless";
import { requireSession, type Session } from "./accounts";
import { PLANS, isUnlimited } from "./plans";

// Plan limits: posts and AI videos per calendar month, and brands per workspace.
export class LimitError extends Error {
  name = "LimitError";
}

function client() {
  return neon(process.env.DATABASE_URL!);
}
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };

export type Usage = { posts: number; videos: number; brands: number };

export async function usageFor(workspaceId: string): Promise<Usage> {
  const since = monthStart();
  const [p, v, b] = await Promise.all([
    client()`select count(*)::int as n from posts where created_at >= ${since} and brand_id in (select id from brands where workspace_id = ${workspaceId})`,
    // A reel's scene clips count as one video: count posts with AI video, plus loose clips.
    client()`select count(distinct coalesce(post_id::text, id::text))::int as n from media where kind = 'video' and source = 'ai' and created_at >= ${since} and brand_id in (select id from brands where workspace_id = ${workspaceId})`,
    client()`select count(*)::int as n from brands where workspace_id = ${workspaceId}`,
  ]);
  return { posts: Number((p[0] as { n: number }).n), videos: Number((v[0] as { n: number }).n), brands: Number((b[0] as { n: number }).n) };
}

/** Why this workspace can't create anything right now, or null when it can. */
export function blockedReason(s: Session): string | null {
  const w = s.workspace;
  if (w.plan === "internal" || w.plan === "free") return null;
  if (w.plan === "trial") {
    if (w.trial_ends_at && new Date(w.trial_ends_at).getTime() < Date.now()) return "Your free trial has ended. Choose a plan in Settings to keep creating posts.";
    return null;
  }
  if (w.plan_status === "canceled") return "Your plan has been cancelled. Choose a plan in Settings to keep creating posts.";
  if (w.plan_status === "past_due") return "Your last payment didn't go through. Update your payment details in Settings to keep creating posts.";
  return null;
}

/** How many more posts can be created this month (throws when none). */
export async function postAllowance(): Promise<number> {
  const s = await requireSession();
  const blocked = blockedReason(s);
  if (blocked) throw new LimitError(blocked);
  const plan = PLANS[s.workspace.plan];
  if (isUnlimited(plan.posts)) return Number.MAX_SAFE_INTEGER;
  const left = plan.posts - (await usageFor(s.workspace.id)).posts;
  if (left <= 0) throw new LimitError(`You've used all ${plan.posts} posts on your ${plan.name} plan this month. Upgrade in Settings for more.`);
  return left;
}

export async function assertVideoAllowed(postId?: string): Promise<void> {
  const s = await requireSession();
  // More clips for a post that already has one this month (a reel's scenes) don't count again.
  if (postId) {
    const since = monthStart();
    const has = await client()`select 1 from media where post_id = ${postId} and kind = 'video' and source = 'ai' and created_at >= ${since} limit 1`;
    if (has.length) return;
  }
  const blocked = blockedReason(s);
  if (blocked) throw new LimitError(blocked);
  const plan = PLANS[s.workspace.plan];
  if (isUnlimited(plan.videos)) return;
  if ((await usageFor(s.workspace.id)).videos >= plan.videos) throw new LimitError(`You've used all ${plan.videos} videos on your ${plan.name} plan this month. Upgrade in Settings for more.`);
}

export async function assertBrandAllowed(): Promise<void> {
  const s = await requireSession();
  const blocked = blockedReason(s);
  if (blocked) throw new LimitError(blocked);
  const plan = PLANS[s.workspace.plan];
  if (isUnlimited(plan.brands)) return;
  if ((await usageFor(s.workspace.id)).brands >= plan.brands) throw new LimitError(`Your ${plan.name} plan includes ${plan.brands} brand${plan.brands === 1 ? "" : "s"}. Upgrade in Settings to add more.`);
}
