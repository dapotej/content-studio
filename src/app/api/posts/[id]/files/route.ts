import { NextResponse } from "next/server";
import { z } from "zod";
import { getBrand, getPost, setPublishing } from "@/lib/db";
import { handle, notFound } from "@/lib/http";
import sharp from "sharp";
import { designKey, type PostSpec } from "@/lib/types";

const PHOTO_DESIGNS = new Set(["photo", "photo_band", "photo_frame", "photo_stat", "split", "carousel"]);

/**
 * A photo post whose image came out without its photo: the area where every photo design shows
 * the photo (left of centre, upper middle) is a single flat colour. Rejected so it never goes out.
 */
async function photoMissing(spec: PostSpec, url: string): Promise<boolean> {
  if (!PHOTO_DESIGNS.has(spec.template) || !spec.media?.url) return false;
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const img = sharp(Buffer.from(await res.arrayBuffer()));
    const { width = 1080, height = 1350 } = await img.metadata();
    const area = await img.extract({ left: Math.round(width * 0.08), top: Math.round(height * 0.27), width: Math.round(width * 0.3), height: Math.round(height * 0.16) }).toBuffer();
    const stats = await sharp(area).stats();
    const spread = stats.channels.slice(0, 3).reduce((s, c) => s + c.stdev, 0) / 3;
    return spread < 3;
  } catch {
    return false; // never block a post because the check itself failed
  }
}

const File = z.object({
  url: z.url().refine((u) => new URL(u).hostname.endsWith(".public.blob.vercel-storage.com"), "Not a Buzzbite upload."),
  type: z.enum(["image", "video", "document"]),
  title: z.string().max(200).optional(),
});
const Body = z.object({ key: z.string().max(64), files: z.object({ instagram: z.array(File).min(1).max(10), linkedin: z.array(File).min(1).max(10) }) });

/** Saves the final files the browser made from a post, for posting. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { key, files } = Body.parse(await req.json());
  const post = await getPost(id);
  if (!post) return notFound();
  const brand = await getBrand(post.brand_id);
  if (!brand) return notFound();
  if (key !== designKey(post.spec, brand.updated_at)) {
    return NextResponse.json({ error: "The post changed while its files were being made. Try again." }, { status: 409 });
  }
  const first = files.instagram[0];
  if (first?.type === "image" && (await photoMissing(post.spec, first.url))) {
    return NextResponse.json({ error: "The photo didn't make it into this post's image, so it wasn't saved. Try approving again." }, { status: 422 });
  }
  return NextResponse.json(await setPublishing(id, { files, filesKey: key }));
});
