// 紙娃娃預覽的共用合成邏輯 + 匯出工具（PNG / GIF / 動畫 WebP）。
// AvatarPreview 的即時繪製與這裡的匯出走同一套 composeFrame，保證下載畫面與預覽一致。
// WebP 沒有現成輕量 JS 編碼器：每幀交給瀏覽器 canvas.toBlob("image/webp") 編靜態圖，
// 再自己手寫 RIFF muxer 組成動畫檔（VP8X + ANIM + ANMF）。

import { GIFEncoder, applyPalette, quantize } from "gifenc";
import type { AvatarFrame, AvatarFrames } from "../api";
import { t } from "../i18n";

/** 幀序列的累計時間表；delay 缺漏時以 120ms 保底，最短 30ms 避免瘋狂跳幀。 */
export interface Sequence {
  cumulative: number[];
  total: number;
}

export function buildSequence(frames: AvatarFrame[] | undefined): Sequence | null {
  if (!frames || frames.length === 0) return null;
  const cumulative: number[] = [];
  let total = 0;
  for (const frame of frames) {
    total += Math.max(30, frame.delay || 120);
    cumulative.push(total);
  }
  return { cumulative, total };
}

export function frameIndexAt(sequence: Sequence, time: number): number {
  const wrapped = ((time % sequence.total) + sequence.total) % sequence.total;
  for (let i = 0; i < sequence.cumulative.length; i += 1) {
    if (wrapped < sequence.cumulative[i]) return i;
  }
  return sequence.cumulative.length - 1;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/** 組出某一時刻要畫的全部圖層（絕對座標、z 遞減=底層在前）。
 *  表情層是相對 brow 錨點的相對座標，在這裡用當下身體幀的 faceAnchor 即時配對，
 *  並按 z 與身體圖層交錯排序（瀏海 hairOverHead 會正確蓋在臉上）。
 *  ItemEff 特效層本身就是絕對座標，直接併入一起排序。 */
export function composeLayers(
  bodyFrame: AvatarFrame | undefined,
  faceFrame: AvatarFrame | undefined,
  effectFrame?: AvatarFrame | undefined,
): AvatarFrame["layers"] {
  if (!bodyFrame) return [];
  const layers = [...bodyFrame.layers];
  if (bodyFrame.showFace && bodyFrame.faceAnchor && faceFrame) {
    const [anchorX, anchorY] = bodyFrame.faceAnchor;
    for (const layer of faceFrame.layers) {
      layers.push({ ...layer, x: anchorX + layer.x, y: anchorY + layer.y });
    }
  }
  if (effectFrame) layers.push(...effectFrame.layers);
  return layers.sort((a, b) => b.z - a.z);
}

/** 全部幀全部圖層的 bounding box（置中與縮放共用）。
 *  表情層是相對座標，需逐身體幀配對後再納入範圍計算；特效層是絕對座標，獨立掃。 */
export function computeBoundingBox(
  frames: AvatarFrames,
  images: Map<string, HTMLImageElement>,
): BoundingBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (layer: AvatarFrame["layers"][number]) => {
    const img = images.get(layer.path);
    if (!img) return;
    minX = Math.min(minX, layer.x);
    minY = Math.min(minY, layer.y);
    maxX = Math.max(maxX, layer.x + img.naturalWidth);
    maxY = Math.max(maxY, layer.y + img.naturalHeight);
  };
  for (const bodyFrame of frames.frames) {
    for (const faceFrame of frames.faceFrames.length > 0 ? frames.faceFrames : [undefined]) {
      for (const layer of composeLayers(bodyFrame, faceFrame)) {
        extend(layer);
      }
    }
  }
  for (const effectFrame of frames.effectFrames) {
    for (const layer of effectFrame.layers) {
      extend(layer);
    }
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/** 把指定 body 幀 + face 幀 + 特效幀合成畫到 ctx（會先清整張畫布）；
 *  表情以當下身體幀的錨點配對、特效直接以絕對座標併入，按 z 交錯。 */
export function composeFrame(
  ctx: CanvasRenderingContext2D,
  frames: AvatarFrames,
  images: Map<string, HTMLImageElement>,
  bodyIndex: number,
  faceIndex: number,
  effectIndex: number,
  originX: number,
  originY: number,
  scale: number,
): void {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const layers = composeLayers(
    frames.frames[bodyIndex],
    faceIndex >= 0 ? frames.faceFrames[faceIndex] : undefined,
    effectIndex >= 0 ? frames.effectFrames[effectIndex] : undefined,
  );
  for (const layer of layers) {
    const img = images.get(layer.path);
    if (!img) continue;
    ctx.drawImage(
      img,
      originX + layer.x * scale,
      originY + layer.y * scale,
      img.naturalWidth * scale,
      img.naturalHeight * scale,
    );
  }
}

// ── 匯出 ─────────────────────────────────────────────────────

const EXPORT_MAX_SIDE = 512; // 輸出最長邊上限（px）
const EXPORT_STEP = 30; // 預設取樣步長（ms）
const EXPORT_MAX_FRAMES = 200; // 最多輸出幀數，超過就把步長調大
const EXPORT_MAX_PERIOD = 10000; // 合併週期封頂（ms）

export interface AvatarScene {
  frames: AvatarFrames;
  images: Map<string, HTMLImageElement>;
  /** 檔名用的動作名。 */
  action: string;
}

interface ExportStage {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  originX: number;
  originY: number;
  scale: number;
}

/** 依 bounding box 建立輸出畫布：整數倍放大（最長邊 ≤512）、寬高取偶數（WebP VP8 需要）。 */
function createExportStage(frames: AvatarFrames, images: Map<string, HTMLImageElement>): ExportStage {
  const box = computeBoundingBox(frames, images);
  if (!box) throw new Error(t("avatar.export.noFrame"));
  const fit = EXPORT_MAX_SIDE / Math.max(box.width, box.height);
  const scale = fit >= 1 ? Math.max(1, Math.floor(fit)) : fit;
  const drawWidth = box.width * scale;
  const drawHeight = box.height * scale;
  const width = Math.max(2, Math.ceil(drawWidth / 2) * 2);
  const height = Math.max(2, Math.ceil(drawHeight / 2) * 2);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("avatar.export.canvasFailed"));
  return {
    canvas,
    ctx,
    originX: Math.floor((width - drawWidth) / 2 - box.minX * scale),
    originY: Math.floor((height - drawHeight) / 2 - box.minY * scale),
    scale,
  };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

interface Timeline {
  step: number;
  count: number;
}

/** body / face / 特效的合併週期（lcm，封頂 10000ms）+ 固定步長取樣（最多 200 幀）。 */
function buildTimeline(totals: number[]): Timeline {
  const rawPeriod = totals.filter((total) => total > 0).reduce((acc, total) => lcm(acc, total), 1);
  const period = Math.min(Math.max(rawPeriod, EXPORT_STEP), EXPORT_MAX_PERIOD);
  const step = period / EXPORT_STEP > EXPORT_MAX_FRAMES
    ? Math.ceil(period / EXPORT_MAX_FRAMES)
    : EXPORT_STEP;
  return { step, count: Math.max(1, Math.ceil(period / step)) };
}

/** 依時間軸逐幀合成，對每幀呼叫 onFrame（此時 stage 畫布上就是該幀畫面）。 */
async function forEachExportFrame(
  scene: AvatarScene,
  onFrame: (stage: ExportStage, step: number) => void | Promise<void>,
): Promise<void> {
  const bodySequence = buildSequence(scene.frames.frames);
  if (!bodySequence) throw new Error(t("avatar.export.noAnimation"));
  const faceSequence = buildSequence(scene.frames.faceFrames);
  const effectSequence = buildSequence(scene.frames.effectFrames);
  const stage = createExportStage(scene.frames, scene.images);
  const { step, count } = buildTimeline([
    bodySequence.total,
    faceSequence?.total ?? 0,
    effectSequence?.total ?? 0,
  ]);
  for (let i = 0; i < count; i += 1) {
    const time = i * step;
    composeFrame(
      stage.ctx,
      scene.frames,
      scene.images,
      frameIndexAt(bodySequence, time),
      faceSequence ? frameIndexAt(faceSequence, time) : -1,
      effectSequence ? frameIndexAt(effectSequence, time) : -1,
      stage.originX,
      stage.originY,
      stage.scale,
    );
    await onFrame(stage, step);
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(t("avatar.export.encodeFailed")))),
      type,
      quality,
    );
  });
}

/** 下載指定畫布的目前畫面（PNG）。 */
export async function exportCanvasPng(canvas: HTMLCanvasElement, action: string): Promise<void> {
  const blob = await canvasToBlob(canvas, "image/png");
  downloadBlob(blob, `avatar_${action}_${timestamp()}.png`);
}

/** 依時間軸合成整個循環並下載 GIF（透明保留，無限循環）。 */
export async function exportGif(scene: AvatarScene): Promise<void> {
  const gif = GIFEncoder();
  await forEachExportFrame(scene, (stage, step) => {
    const { data, width, height } = stage.ctx.getImageData(
      0,
      0,
      stage.canvas.width,
      stage.canvas.height,
    );
    // rgba4444 + oneBitAlpha：透明像素量化成 a=0 的調色盤 entry，對應 GIF 透明 index。
    const palette = quantize(data, 256, { format: "rgba4444", oneBitAlpha: true });
    const index = applyPalette(data, palette, "rgba4444");
    const transparentIndex = palette.findIndex((color) => (color[3] ?? 0xff) === 0);
    gif.writeFrame(index, width, height, {
      palette,
      delay: step,
      repeat: 0,
      transparent: transparentIndex >= 0,
      transparentIndex: Math.max(0, transparentIndex),
    });
  });
  gif.finish();
  const bytes = gif.bytes();
  // gifenc 的 bytes() 是 slice 出來的獨立 buffer，可直接整個帶走。
  downloadBlob(new Blob([bytes.buffer as ArrayBuffer], { type: "image/gif" }), gifName(scene.action));
}

function gifName(action: string): string {
  return `avatar_${action}_${timestamp()}.gif`;
}

// ── 動畫 WebP（手寫 RIFF muxer）─────────────────────────────

interface RiffChunk {
  fourcc: string;
  payload: Uint8Array;
}

function fourccOf(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** 解析靜態 WebP 的 RIFF chunks（只取 ALPH 與 VP8/VP8L 用）。 */
function parseWebPChunks(buffer: ArrayBuffer): RiffChunk[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 12 || fourccOf(bytes, 0) !== "RIFF" || fourccOf(bytes, 8) !== "WEBP") {
    throw new Error(t("avatar.export.webpInvalid"));
  }
  const chunks: RiffChunk[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true);
    chunks.push({ fourcc: fourccOf(bytes, offset), payload: bytes.subarray(offset + 8, offset + 8 + size) });
    offset += 8 + size + (size % 2); // chunk 長度補偶數對齊
  }
  return chunks;
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function u24le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
}

/** 組一個 RIFF chunk（含 fourcc、長度、payload、偶數對齊補位）。 */
function riffChunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length + (payload.length % 2));
  out.set(ascii(fourcc), 0);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 把每幀的 ALPH + VP8/VP8L chunks 組成動畫 WebP（透明背景、無限循環）。 */
function muxAnimatedWebP(
  frames: { alph: RiffChunk | null; image: RiffChunk }[],
  width: number,
  height: number,
  delay: number,
): Blob {
  // VP8X：flags = animation(0x02) | alpha(0x10)，canvas 寬高存 -1 後的 24-bit。
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02 | 0x10;
  vp8x.set(u24le(width - 1), 4);
  vp8x.set(u24le(height - 1), 7);
  // ANIM：背景 BGRA 全 0（透明）、loop=0 無限循環。
  const anim = new Uint8Array(6);

  const anmfChunks = frames.map(({ alph, image }) => {
    // ANMF frame header 16 bytes：x/y（24-bit，值為實際/2）、寬高-1（24-bit）、
    // delay（24-bit ms）、flags（0x02 = no blend）。
    const header = new Uint8Array(16);
    header.set(u24le(width - 1), 6);
    header.set(u24le(height - 1), 9);
    header.set(u24le(Math.min(delay, 0xffffff)), 12);
    header[15] = 0x02;
    const subChunks = alph ? [riffChunk("ALPH", alph.payload), riffChunk(image.fourcc, image.payload)] : [riffChunk(image.fourcc, image.payload)];
    return riffChunk("ANMF", concat([header, ...subChunks]));
  });

  const body = concat([riffChunk("VP8X", vp8x), riffChunk("ANIM", anim), ...anmfChunks]);
  const header = new Uint8Array(12);
  header.set(ascii("RIFF"), 0);
  new DataView(header.buffer).setUint32(4, 4 + body.length, true);
  header.set(ascii("WEBP"), 8);
  const file = concat([header, body]);
  return new Blob([file.buffer as ArrayBuffer], { type: "image/webp" });
}

/** 依時間軸合成整個循環並下載動畫 WebP。 */
export async function exportWebP(scene: AvatarScene): Promise<void> {
  const frames: { alph: RiffChunk | null; image: RiffChunk }[] = [];
  let width = 0;
  let height = 0;
  let step = EXPORT_STEP;
  await forEachExportFrame(scene, async (stage, frameStep) => {
    step = frameStep;
    width = stage.canvas.width;
    height = stage.canvas.height;
    const blob = await canvasToBlob(stage.canvas, "image/webp", 0.92);
    const chunks = parseWebPChunks(await blob.arrayBuffer());
    const image = chunks.find((chunk) => chunk.fourcc === "VP8 " || chunk.fourcc === "VP8L");
    if (!image) throw new Error(t("avatar.export.webpNoImage"));
    frames.push({ alph: chunks.find((chunk) => chunk.fourcc === "ALPH") ?? null, image });
  });
  downloadBlob(muxAnimatedWebP(frames, width, height, step), `avatar_${scene.action}_${timestamp()}.webp`);
}
