import "server-only";
import { planPosts, type PostDraft } from "./ai";
import {
  createPost, finishMedia, getPost, insertMedia, latestTrendReport, listPendingMedia, listPostsBetween, recentPostTitles, updatePost,
} from "./db";
import { checkJob, describeFalError, queueImage, queueReferenceImage, queueVideo } from "./media";
import { advanceReelMedia, startReelMedia } from "./reels";
import { notify } from "./notify";
import { performanceNotes } from "./results";
import { TEMPLATES, type Brand, type Post, type PostSpec } from "./types";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Posting dates between from and to (inclusive) on the brand's chosen weekdays. */
export function postingDates(brand: Brand, from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(from + "T00:00:00Z"); iso(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    if (brand.settings.days.includes((d.getUTCDay() + 6) % 7)) out.push(iso(d));
  }
  return out;
}

/** Dates in the range that still need a post. */
export async function emptyDates(brand: Brand, from: string, to: string): Promise<string[]> {
  const taken = new Set((await listPostsBetween(brand.id, from, to)).map((p) => p.publish_on));
  return postingDates(brand, from, to).filter((d) => !taken.has(d));
}

const todayLong = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** Plans and saves posts for up to `limit` empty dates. Returns how many were made and how many remain. */
export async function fillDates(brand: Brand, from: string, to: string, limit = 7): Promise<{ made: number; remaining: number }> {
  const empty = await emptyDates(brand, from, to);
  const batch = empty.slice(0, limit);
  if (!batch.length) return { made: 0, remaining: 0 };
  const trends = await latestTrendReport(brand.id);
  const drafts = await planPosts(brand.profile, batch, {
    recentTitles: await recentPostTitles(brand.id),
    trends: trends ? `${trends.summary}\n${trends.items.slice(0, 8).map((i) => `- ${i.title}: ${i.whyNow}`).join("\n")}` : "",
    today: todayLong(),
    results: await performanceNotes(brand.id),
  });
  for (const d of drafts) await savePost(brand, d, d.date);
  if (drafts.length) await notify(brand.id, { kind: "review", title: `${drafts.length} new post${drafts.length === 1 ? "" : "s"} to review`, body: `Planned for ${drafts.map((d) => d.date).sort()[0]} onwards. Photos and videos are being made now.`, link: `/b/${brand.id}/review` });
  return { made: drafts.length, remaining: Math.max(0, empty.length - drafts.length) };
}

/** Saves a drafted post and starts making its photo (and video) if the design needs one. */
export async function savePost(brand: Brand, draft: PostDraft, date: string | null, ideaId?: string): Promise<Post> {
  const spec: PostSpec = { ...draft.spec, media: null, clip: null };
  const post = await createPost({
    brand_id: brand.id, idea_id: ideaId ?? null, publish_on: date, status: "review",
    title: draft.title, pillar: draft.pillar, spec, linkedin: draft.linkedin, instagram: draft.instagram,
  });
  return startMedia(brand, post);
}

/** Queues a photo in the brand's art direction, drawn from the product reference photos when it shows the product. */
export async function queuePhoto(brand: Brand, imagePrompt: string, showsProduct: boolean, aspect: "4:5" | "9:16") {
  const style = brand.profile.imageStyle || "natural, modern, premium photography";
  const refs = brand.settings.references;
  const frame = aspect === "9:16" ? "Vertical 9:16 frame for a phone screen, with calm space at the bottom for subtitles." : "Portrait 4:5 frame with calm space for a headline.";
  if (showsProduct && refs.length) {
    return queueReferenceImage(
      `Create a new photograph: ${imagePrompt.trim()}\n\n` +
      `The attached photo${refs.length > 1 ? "s show" : " shows"} the brand's real product. Draw the product exactly as it appears there: same shape, size, number, position and orientation. ` +
      `Copy only the product; the scene, place, people and light come from the description above.\n` +
      refs.map((r, i) => (r.note.trim() ? `Reference ${i + 1}: ${r.note.trim()}\n` : "")).join("") +
      `Art direction: ${style}\nNo readable text, letters, logos or brand names anywhere in the image. ${frame}`,
      refs.map((r) => r.url),
      aspect,
    );
  }
  return queueImage(`${imagePrompt.trim()} Art direction: ${style}. ${frame} No text, letters, logos or signage.`, aspect);
}

/** Queues the photo a post needs (or a reel's scenes). Posts that need no photo go straight to review. */
export async function startMedia(brand: Brand, post: Post, previous?: PostSpec): Promise<Post> {
  if (post.spec.template === "reel") return startReelMedia(brand, post, previous);
  const t = TEMPLATES[post.spec.template];
  if (!t?.usesPhoto || post.spec.media || !post.spec.imagePrompt.trim()) {
    return (await updatePost(post.id, { status: "review", issue: null }))!;
  }
  try {
    const job = await queuePhoto(brand, post.spec.imagePrompt, post.spec.showsProduct, "4:5");
    await insertMedia({
      brand_id: brand.id, post_id: post.id, role: "image", kind: "image", status: "pending", source: "ai", url: null,
      description: post.spec.imagePrompt.slice(0, 300), fal_endpoint: job.endpoint, fal_request_id: job.requestId,
    });
    return (await updatePost(post.id, { status: "making", issue: null }))!;
  } catch (e) {
    const issue = describeFalError(e);
    console.error("image queue failed:", issue, JSON.stringify((e as { body?: unknown }).body ?? null));
    return (await updatePost(post.id, { status: "review", issue }))!;
  }
}

/** Checks every pending photo and clip for the brand and moves finished posts on. */
export async function advance(brand: Brand): Promise<{ pending: number }> {
  const pending = await listPendingMedia(brand.id);
  let still = 0;
  for (const m of pending) {
    if (!m.fal_endpoint || !m.fal_request_id) continue;
    const out = await checkJob(m.fal_endpoint, m.fal_request_id, m.kind, brand.id, { vertical: m.role?.startsWith("scene:") ?? false }).catch((e) => ({ state: "failed" as const, error: String(e) }));
    if (out.state === "pending") { still++; continue; }
    if (out.state === "failed") await finishMedia(m.id, { status: "failed", error: out.error });
    else await finishMedia(m.id, { status: "ready", url: out.url });
    if (!m.post_id) continue;
    const post = await getPost(m.post_id);
    if (!post) continue;
    if (m.role?.startsWith("scene:") || m.role === "music") {
      await advanceReelMedia(brand, post, m.role, out);
      continue;
    }

    if (m.role === "image") {
      if (out.state === "failed") {
        await updatePost(post.id, { status: "review", issue: `The photo could not be made: ${out.error}` });
        continue;
      }
      const spec: PostSpec = { ...post.spec, media: { id: m.id, url: out.url, kind: "image" } };
      if (post.spec.template === "video" && !post.spec.clip) {
        try {
          const job = await queueVideo(post.spec.motionPrompt || "Slow, subtle camera push-in. Natural movement.", out.url);
          await insertMedia({
            brand_id: brand.id, post_id: post.id, role: "video", kind: "video", status: "pending", source: "ai", url: null,
            description: `${m.description} (animated)`, fal_endpoint: job.endpoint, fal_request_id: job.requestId,
          });
          await updatePost(post.id, { spec });
          still++;
          continue;
        } catch (e) {
          const issue = `The photo is ready but the video could not be started. ${describeFalError(e)}`;
          console.error("video queue failed:", issue);
          await updatePost(post.id, { spec, status: "review", issue });
          continue;
        }
      }
      await updatePost(post.id, { spec, status: post.status === "making" ? "review" : post.status, issue: null });
    } else if (m.role === "video") {
      const failed = out.state === "failed";
      const spec: PostSpec = failed ? post.spec : { ...post.spec, clip: { id: m.id, url: out.url, kind: "video" } };
      await updatePost(post.id, { spec, status: post.status === "making" ? "review" : post.status, issue: failed ? `The video could not be made: ${out.error}` : null });
    }
  }
  return { pending: still };
}

/** Tries again to make the photo, or the video clip, a post is missing. */
export async function retryMedia(brand: Brand, post: Post): Promise<Post> {
  if (post.spec.template === "reel") return startReelMedia(brand, post, post.spec);
  if (post.spec.template === "video" && post.spec.media?.url && !post.spec.clip) {
    try {
      const job = await queueVideo(post.spec.motionPrompt || "Slow, subtle camera push-in with natural movement in the scene.", post.spec.media.url);
      await insertMedia({ brand_id: brand.id, post_id: post.id, role: "video", kind: "video", status: "pending", source: "ai", url: null, description: "Animated photo", fal_endpoint: job.endpoint, fal_request_id: job.requestId });
      return (await updatePost(post.id, { status: "making", issue: null }))!;
    } catch (e) {
      return (await updatePost(post.id, { issue: `The video could not be started. ${describeFalError(e)}` }))!;
    }
  }
  const fresh = await updatePost(post.id, { spec: { ...post.spec, media: null, clip: null }, issue: null });
  return startMedia(brand, fresh!);
}
