import "server-only";
import { getBrand, listPostsInFlight, setPublishing, updatePost } from "./db";
import { notify } from "./notify";
import { PLATFORMS, designKey, type Brand, type Platform, type Post } from "./types";
import { PostingError, createPost, deletePost, getPost, postingConfigured, type ZTarget } from "./zernio";

/** The current wall-clock time in a time zone, as "YYYY-MM-DDTHH:MM". */
function localNow(tz: string): string {
  return new Date().toLocaleString("sv-SE", { timeZone: tz, hour12: false }).replace(" ", "T").slice(0, 16);
}

/** Platforms this post goes to: the ones chosen for it (or all) that have a connected account. */
export function postTargets(brand: Brand, post: Post): Platform[] {
  const connected = new Set(brand.social.accounts.map((a) => a.platform));
  return (post.publishing.targets ?? [...PLATFORMS]).filter((p) => connected.has(p));
}

const message = (e: unknown) => (e instanceof PostingError ? e.message : "Something went wrong while scheduling. Try again.");

/**
 * Hands an approved post to the posting service for its date and the brand's posting time.
 * Any earlier booking of the post is cancelled first. Problems are saved on the post, never thrown.
 */
export async function schedulePost(brand: Brand, post: Post, opts: { now?: boolean } = {}): Promise<Post> {
  if (!postingConfigured() || post.status !== "approved") return post;
  const targets = postTargets(brand, post);
  if (!targets.length) return post;
  const save = async (patch: Parameters<typeof setPublishing>[1]) => (await setPublishing(post.id, patch)) ?? post;

  const files = post.publishing.files;
  if (!files || post.publishing.filesKey !== designKey(post.spec, brand.updated_at)) {
    return save({ error: "The post changed since its files were made. Open it and approve it again.", state: null });
  }
  if (!post.publish_on && !opts.now) return save({ error: "Give the post a date to schedule it.", state: null });
  const when = opts.now ? null : `${post.publish_on}T${brand.settings.time}`;
  if (when && when <= localNow(brand.settings.tz)) {
    return save({ error: "This post's date and time have passed. Move it to another day, or post it now.", state: null });
  }

  try {
    if (post.publishing.zernioId && post.publishing.state !== "published" && post.publishing.state !== "partial") {
      await deletePost(post.publishing.zernioId);
    }
    const zTargets: ZTarget[] = targets.map((platform) => {
      const account = brand.social.accounts.find((a) => a.platform === platform)!;
      const media = files[platform];
      const doc = media.find((m) => m.type === "document");
      return {
        platform, accountId: account.id,
        customContent: platform === "instagram" ? post.instagram : post.linkedin,
        customMedia: media.map((m) => ({ url: m.url, type: m.type, ...(m.title ? { title: m.title } : {}) })),
        ...(platform === "linkedin" && doc ? { platformSpecificData: { documentTitle: doc.title ?? post.title } } : {}),
      };
    });
    const made = await createPost({
      title: post.title, targets: zTargets, scheduledFor: when ? `${when}:00` : null, timezone: brand.settings.tz,
      idempotencyKey: crypto.randomUUID(), externalId: post.id,
    });
    const saved = await save({ zernioId: made.id, state: made.state, error: null, urls: {}, scheduledFor: when });
    // "Post now" publishes straight away: pick up the result.
    return opts.now ? await syncPost(saved) : saved;
  } catch (e) {
    return save({ zernioId: null, state: null, error: message(e), scheduledFor: null });
  }
}

/** Cancels a post that has not gone out yet. */
export async function unschedulePost(post: Post): Promise<void> {
  const p = post.publishing;
  if (!p.zernioId || p.state === "published" || p.state === "partial") {
    if (p.error) await setPublishing(post.id, { error: null });
    return;
  }
  try {
    await deletePost(p.zernioId);
  } catch {
    // If the cancel fails the booking may still stand; say so rather than hiding it.
    await setPublishing(post.id, { error: "Could not cancel the scheduled post. Delete it in Zernio to stop it going out." });
    return;
  }
  await setPublishing(post.id, { zernioId: null, state: null, error: null, scheduledFor: null });
}

/** Reads the post's result from the posting service; marks it posted once it is live. */
export async function syncPost(post: Post): Promise<Post> {
  const id = post.publishing.zernioId;
  if (!id) return post;
  try {
    const r = await getPost(id);
    let next = (await setPublishing(post.id, { state: r.state, urls: r.urls, error: r.error })) ?? post;
    if ((r.state === "published" || r.state === "partial") && post.status !== "posted") next = (await updatePost(post.id, { status: "posted" })) ?? next;
    if (r.state !== post.publishing.state) {
      const where = Object.keys(r.urls).map((p) => (p === "linkedin" ? "LinkedIn" : "Instagram")).join(" and ");
      const link = `/b/${post.brand_id}/review?post=${post.id}`;
      if (r.state === "published") await notify(post.brand_id, { postId: post.id, kind: "posted", title: `Posted: ${post.title}`, body: where ? `Live on ${where}.` : "", link: Object.values(r.urls)[0] ?? link, dedupe: `posted:${post.id}` });
      else if (r.state === "partial") await notify(post.brand_id, { postId: post.id, kind: "failed", title: `Only partly posted: ${post.title}`, body: r.error ?? "", link, dedupe: `partial:${post.id}` });
      else if (r.state === "failed") await notify(post.brand_id, { postId: post.id, kind: "failed", title: `Didn't go out: ${post.title}`, body: r.error ?? "", link, dedupe: `failed:${post.id}:${post.publishing.zernioId}` });
    }
    return next;
  } catch {
    return post;
  }
}

/** Checks every post that is due, so the calendar shows what went out. */
export async function syncBrand(brandId: string): Promise<number> {
  const brand = await getBrand(brandId);
  if (!brand || !postingConfigured()) return 0;
  const now = localNow(brand.settings.tz);
  const due = (await listPostsInFlight(brandId)).filter((p) => !p.publishing.scheduledFor || p.publishing.scheduledFor <= now).slice(0, 10);
  let changed = 0;
  for (const p of due) {
    const next = await syncPost(p);
    if (next.publishing.state !== p.publishing.state) changed++;
  }
  return changed;
}
