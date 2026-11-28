"use client";
import { getFontEmbedCSS, toCanvas, toJpeg, toPng } from "html-to-image";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { MOTION_SECONDS, POST_H, POST_W } from "@/templates/PostCanvas";

/** Loads a brand's Google Fonts with CORS so they can be embedded in exports. */
export function ensureFonts(families: string[]) {
  for (const f of new Set(families.filter(Boolean))) {
    const id = `gf-${f.replace(/\W+/g, "-")}`;
    if (document.getElementById(id)) continue;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.crossOrigin = "anonymous";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}:wght@400;500;600;700&display=swap`;
    document.head.appendChild(link);
  }
}

// Videos are skipped: freezeVideos() puts an image of the current frame next to each one.
const opts = (fontEmbedCSS: string) => ({
  width: POST_W, height: POST_H, pixelRatio: 1, fontEmbedCSS, cacheBust: false,
  filter: (n: HTMLElement) => n.tagName !== "VIDEO",
});

/** Photos live on Vercel Blob; fetch them through the app's own image route so the browser never blocks them. */
function sameOrigin(src: string): string {
  if (/^https:\/\/[^/]+\.public\.blob\.vercel-storage\.com\//.test(src)) return `/_next/image?url=${encodeURIComponent(src)}&w=1080&q=90`;
  return src;
}

/**
 * Puts every photo into the post as data, before capture. html-to-image otherwise fetches each
 * photo again on its own, and when that fetch fails it quietly leaves the photo out: the post
 * went out as text on a blank background. Throws instead, so a post never goes out without its photo.
 */
async function inlineImages(node: HTMLElement): Promise<() => void> {
  const undo: (() => void)[] = [];
  for (const img of Array.from(node.querySelectorAll("img"))) {
    const src = img.getAttribute("src") || "";
    if (!src || src.startsWith("data:")) continue;
    let data: string;
    try {
      const res = await fetch(sameOrigin(src), { cache: "force-cache" });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      data = await new Promise<string>((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(fr.error); fr.readAsDataURL(blob); });
    } catch {
      throw new Error("A photo in this post could not be loaded, so its files weren't made. Check your connection and try again.");
    }
    img.removeAttribute("srcset");
    img.src = data;
    await img.decode().catch(() => { throw new Error("A photo in this post could not be read. Try again, or give the post a new photo."); });
    undo.push(() => { img.src = src; });
  }
  return () => undo.forEach((u) => u());
}

function seek(video: HTMLVideoElement, seconds: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - seconds) < 0.001) return resolve();
    const done = () => { video.removeEventListener("seeked", done); resolve(); };
    video.addEventListener("seeked", done);
    video.currentTime = seconds;
  });
}

async function ready(video: HTMLVideoElement) {
  if (video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadeddata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("The video could not be loaded for export.")), { once: true });
  });
}

/**
 * html-to-image stretches <video> frames, so each video is swapped for an <img> of its
 * current frame, which keeps the video's object-fit crop. Returns a function that undoes the swap.
 */
async function freezeVideos(node: HTMLElement, atSeconds?: number): Promise<() => void> {
  const undo: (() => void)[] = [];
  for (const video of Array.from(node.querySelectorAll("video"))) {
    await ready(video);
    video.pause();
    if (atSeconds !== undefined && video.duration) await seek(video, atSeconds % video.duration);
    // Grab the frame at the video's own size; the <img> crops it with object-fit like the video did.
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const img = document.createElement("img");
    img.className = video.className;
    img.alt = "";
    img.src = canvas.toDataURL("image/jpeg", 0.92);
    await img.decode().catch(() => undefined);
    video.style.display = "none";
    video.after(img);
    undo.push(() => { img.remove(); video.style.display = ""; });
  }
  return () => undo.forEach((u) => u());
}

/** How long the MP4 should be: the motion template's length, or the background clip's (max 15 s). */
export async function videoSeconds(node: HTMLElement): Promise<number> {
  const video = node.querySelector("video");
  if (!video) return MOTION_SECONDS;
  await ready(video);
  return Math.min(15, Math.max(3, Math.floor(video.duration || MOTION_SECONDS)));
}

export async function exportPng(node: HTMLElement, format: "png" | "jpeg" = "png"): Promise<Blob> {
  await document.fonts.ready;
  const css = await getFontEmbedCSS(node);
  const restoreImages = await inlineImages(node);
  const restore = await freezeVideos(node);
  try {
    // Instagram only accepts JPEG photos.
    const url = format === "jpeg" ? await toJpeg(node, { ...opts(css), quality: 0.93 }) : await toPng(node, opts(css));
    return (await fetch(url)).blob();
  } finally {
    restore();
    restoreImages();
    node.querySelectorAll("video").forEach((v) => void v.play().catch(() => undefined));
  }
}

function animationsOf(node: HTMLElement): Animation[] {
  return node.getAnimations({ subtree: true });
}

async function pickCodec(): Promise<{ codec: string; muxCodec: "avc" | "vp9" } | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const candidates: { codec: string; muxCodec: "avc" | "vp9" }[] = [
    { codec: "avc1.640028", muxCodec: "avc" }, // H.264 High: what Instagram and LinkedIn expect
    { codec: "avc1.4d0028", muxCodec: "avc" },
    { codec: "vp09.00.40.08", muxCodec: "vp9" },
  ];
  for (const c of candidates) {
    const { supported } = await VideoEncoder.isConfigSupported({ codec: c.codec, width: POST_W, height: POST_H, bitrate: 8_000_000, framerate: 30 });
    if (supported) return c;
  }
  return null;
}

/**
 * Records the motion template frame by frame: every CSS animation inside `node`
 * is paused and seeked to the frame's time, the DOM is drawn to a canvas, and the
 * frames are encoded to MP4 in the browser.
 */
export async function exportMp4(node: HTMLElement, onProgress: (fraction: number) => void): Promise<{ blob: Blob; codec: string }> {
  const picked = await pickCodec();
  if (!picked) throw new Error("This browser cannot encode video. Use a recent Chrome, Edge or Safari.");
  await document.fonts.ready;
  const fontCss = await getFontEmbedCSS(node);
  const restoreImages = await inlineImages(node);
  const fps = 30;
  const frames = (await videoSeconds(node)) * fps;

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: picked.muxCodec, width: POST_W, height: POST_H }, fastStart: "in-memory" });
  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encodeError = e),
  });
  encoder.configure({ codec: picked.codec, width: POST_W, height: POST_H, bitrate: 8_000_000, framerate: fps });

  const anims = animationsOf(node);
  try {
    for (let f = 0; f < frames; f++) {
      if (encodeError) throw encodeError;
      const t = (f / fps) * 1000;
      for (const a of anims) {
        a.pause();
        a.currentTime = t;
      }
      const restore = await freezeVideos(node, f / fps);
      let canvas: HTMLCanvasElement;
      try {
        canvas = await toCanvas(node, opts(fontCss));
      } finally {
        restore();
      }
      const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1_000_000) / fps), duration: Math.round(1_000_000 / fps) });
      encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();
      // Keep the encoder queue short so memory stays flat.
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
      onProgress((f + 1) / frames);
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
  } finally {
    if (encoder.state !== "closed") encoder.close();
    restoreImages();
    for (const a of anims) {
      a.currentTime = 0;
      a.play();
    }
    node.querySelectorAll("video").forEach((v) => { v.currentTime = 0; void v.play().catch(() => undefined); });
  }
  return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), codec: picked.codec };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Instagram carousel: every slide as a PNG, in one ZIP. */
export async function slidesZip(pngs: Blob[], base: string): Promise<Blob> {
  const { zipSync } = await import("fflate");
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < pngs.length; i++) files[`${base}-${String(i + 1).padStart(2, "0")}.png`] = new Uint8Array(await pngs[i].arrayBuffer());
  return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

/** LinkedIn document carousel: one 1080×1350 page per slide (PNG or JPEG slides). */
export async function slidesPdf(pngs: Blob[]): Promise<Blob> {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  for (const png of pngs) {
    const bytes = new Uint8Array(await png.arrayBuffer());
    const img = png.type === "image/jpeg" ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
    const page = pdf.addPage([POST_W, POST_H]);
    page.drawImage(img, { x: 0, y: 0, width: POST_W, height: POST_H });
  }
  return new Blob([(await pdf.save()) as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
}
