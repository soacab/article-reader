import sharp, { type Sharp } from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import blocked from "./blocked-image.json";
import placeholder from "./placeholder-image.json";
import { safeFetch } from "./network";
import { currentBudget } from "./budget";
import { FetchFailure, resourceRejection } from "./types";
import { apngFrames } from "./apng";
import type { Asset, ImageAttempt, ImageResult } from "./types";

const types: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
export const IMAGE_LIMITS = { frames: 100, pixels: 40_000_000 };
export async function decodePixels(image: Sharp, seconds = 10) {
  try { await image.timeout({ seconds }).raw({ depth: "uchar" }).toBuffer(); }
  catch (error) {
    if (error instanceof Error && /timeout/i.test(error.message)) throw resourceRejection(`图片解码超过 ${seconds} 秒`);
    throw error;
  }
}
export async function validateImage(bytes: Buffer, limits = IMAGE_LIMITS) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 === placeholder.sha256) throw new Error("资源限制：识别到已核实的页面占位图片，未取得实际图片地址");
  if (sha256 === blocked.sha256) throw new Error("识别到微信公众号防盗链提示图");
  const pngFrames = apngFrames(bytes, limits);
  const image = sharp(bytes, { limitInputPixels: false, failOn: "warning" });
  const metadata = await image.metadata();
  const format = metadata.format === "heif" && metadata.compression === "av1" ? "avif" : metadata.format;
  if (format === "svg") throw new Error("资源限制：暂不支持 SVG 图片");
  if (!format || !types[format] || !metadata.width || !metadata.height) throw new Error("不支持或无法解码的图片内容");
  const frames = pngFrames?.frameCount || metadata.pages || 1;
  const totalPixels = metadata.width * metadata.height * frames;
  if (frames > limits.frames) throw resourceRejection(`动画帧数 ${frames} 超过上限 ${limits.frames}`);
  if (totalPixels > limits.pixels) throw resourceRejection(`图片累计像素 ${totalPixels} 超过上限 ${limits.pixels}`);
  // No resize/stats: force all pixels through the native output pipeline, which
  // actually applies timeout(). APNG frames share one ten-second decode budget.
  const deadline = Date.now() + 10_000;
  for (const input of pngFrames?.images || [bytes]) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw resourceRejection("图片解码超过 10 秒");
    try {
      await decodePixels(sharp(input, { animated: !pngFrames && frames > 1, limitInputPixels: limits.pixels, failOn: "warning" }), Math.ceil(remaining / 1000));
    } catch (error) {
      if (pngFrames && !(error instanceof FetchFailure)) throw resourceRejection("APNG 帧解码失败，无法可靠校验");
      throw error;
    }
    if (Date.now() >= deadline) throw resourceRejection("图片解码超过 10 秒");
    currentBudget()?.check();
  }
  currentBudget()?.check();
  // Decode pixels, not just the file header; compare the known denial image across encodings/sizes.
  const pixels = await image.timeout({ seconds: 10 }).flatten({ background: "white" }).resize(32, 32, { fit: "fill" }).greyscale().raw().toBuffer();
  const reference = Buffer.from(blocked.pixels, "base64");
  const error = pixels.reduce((sum, value, i) => sum + Math.abs(value - reference[i]), 0) / reference.length;
  if (Math.abs(metadata.width / metadata.height - 1) < 0.05 && error <= 2) throw new Error("图片像素与已知防盗链提示图匹配");
  return { sha256, mime: types[format], ext: format, width: metadata.width, height: metadata.height };
}

export async function downloadImage(itemId: string, originalUrl: string, occurrences: number, onAttempt: (result: ImageResult) => void, fetcher = safeFetch, referer: string | null = "https://mp.weixin.qq.com/") {
  const result: ImageResult = { originalUrl, occurrences, attempts: [] };
  const modes: ImageAttempt["mode"][] = ["no_referer"];
  if (referer) modes.push(referer === "https://mp.weixin.qq.com/" ? "wechat_referer" : "source_referer");
  for (const mode of modes) {
    const attempt: ImageAttempt = { mode, startedAt: new Date().toISOString(), outcome: "rejected", hops: [] };
    try {
      currentBudget()?.check();
      const response = await fetcher(originalUrl, { referer: mode === "no_referer" ? undefined : referer ?? undefined, maxBytes: 20 * 1024 * 1024, trace: attempt.hops });
      attempt.status = response.status; attempt.bytes = response.body.length;
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      attempt.sha256 = createHash("sha256").update(response.body).digest("hex");
      const checked = await validateImage(response.body);
      attempt.width = checked.width; attempt.height = checked.height;
      currentBudget()?.check();
      const id = randomUUID();
      const relativePath = `${itemId}/${checked.sha256}.${checked.ext}`;
      const destination = path.join(process.cwd(), relativePath);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      currentBudget()?.check();
      await writeFile(destination, response.body, { mode: 0o600 });
      currentBudget()?.check();
      const asset: Asset = { id, itemId, originalUrl, relativePath, mime: checked.mime, bytes: response.body.length, sha256: checked.sha256, width: checked.width, height: checked.height };
      attempt.outcome = "real_image"; result.assetId = id; result.attempts.push(attempt); onAttempt(result);
      return { result, asset };
    } catch (error) {
      attempt.reason = error instanceof Error ? error.message : String(error);
      result.attempts.push(attempt); onAttempt(result);
      if (error instanceof FetchFailure && (error.detail.abortArticle || error.detail.needsAuthorization || (referer === null && error.category === "verification"))) throw error;
      if (attempt.reason.startsWith("资源限制：")) break;
    }
  }
  return { result, asset: null };
}
