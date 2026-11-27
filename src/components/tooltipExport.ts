// 裝備 tooltip 的 canvas 重繪匯出：不依賴 DOM 截圖套件，
// 直接用 ItemTooltip 資料照 .item-tooltip 的版型畫成 PNG 後下載。
// 顏色取自目前主題的 design token（經 1×1 canvas 正規化成 rgb，回避 oklch 解析差異）。
import type { ItemTooltip } from "../api";
import { saveBinaryFile } from "../api";
import { t } from "../i18n";
import { formatItemDescription } from "./ItemTooltip";
import { tooltipText, tooltipTitle, type TooltipText } from "./tooltipText";

const SCALE = 2;
const REM = 16;
const MIN_WIDTH = 240;
const MAX_WIDTH = 340;
const PAD_X = 12;
const ICON_FRAME = 72;
const ICON_SCALE = 2;
const ICON_MIN_SIZE = 34;
const ICON_MAX_SIZE = 68;
const CARD_RADIUS = 6;
// 非裝備戰利品版型（對齊 .drop-item-tooltip）。
const DROP_MAX_WIDTH = 320;
const DROP_PAD_Y = 10;
const DROP_GAP = 12;
const DROP_TEXT_GAP = 5;
const DROP_TEXT_MIN = 80;

const BODY_FONT = '"Segoe UI", Aptos, ui-sans-serif, system-ui, sans-serif';
const MONO_FONT = '"Cascadia Mono", Consolas, monospace';

const numberFormatter = new Intl.NumberFormat();

type Rgb = [number, number, number];

interface Palette {
  textStrong: Rgb;
  muted: Rgb;
  subtle: Rgb;
  warning: Rgb;
  border: Rgb;
  borderStrong: Rgb;
  panel: Rgb;
  surface: Rgb;
  surfaceRaised: Rgb;
}

const css = ([r, g, b]: Rgb, alpha = 1): string => `rgba(${r}, ${g}, ${b}, ${alpha})`;

function formatReq(value: number): string {
  return numberFormatter.format(value);
}

const fontOf = (weight: number, rem: number, mono = false): string =>
  `${weight} ${rem * REM}px ${mono ? MONO_FONT : BODY_FONT}`;

const lineHeight = (rem: number): number => rem * REM * 1.45;

/** 從 :root 讀 design token 並正規化成 rgb 分量（token 可能是 oklch，canvas 端統一走此轉換）。 */
function resolvePalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  const read = (token: string, fallback: Rgb): Rgb => {
    if (!pctx) return fallback;
    pctx.clearRect(0, 0, 1, 1);
    pctx.fillStyle = "#000000";
    pctx.fillRect(0, 0, 1, 1);
    pctx.fillStyle = style.getPropertyValue(token).trim();
    pctx.fillRect(0, 0, 1, 1);
    const d = pctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  return {
    textStrong: read("--text-strong", [23, 23, 23]),
    muted: read("--muted", [99, 99, 99]),
    subtle: read("--subtle", [125, 125, 125]),
    warning: read("--warning", [160, 106, 0]),
    border: read("--border", [220, 220, 220]),
    borderStrong: read("--border-strong", [163, 163, 163]),
    panel: read("--panel", [242, 242, 242]),
    surface: read("--surface", [250, 250, 250]),
    surfaceRaised: read("--surface-raised", [255, 255, 255]),
  };
}

function loadIcon(base64: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `data:image/png;base64,${base64}`;
  });
}

function iconDrawSize(img: HTMLImageElement): { width: number; height: number } {
  const clamp = (v: number) => Math.min(Math.max(v * ICON_SCALE, ICON_MIN_SIZE), ICON_MAX_SIZE);
  return { width: clamp(img.naturalWidth), height: clamp(img.naturalHeight) };
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    let current = "";
    for (const ch of raw) {
      if (current !== "" && ctx.measureText(current + ch).width > maxWidth) {
        lines.push(current);
        current = ch;
      } else {
        current += ch;
      }
    }
    lines.push(current);
  }
  return lines;
}

type ReqTone = "zero" | "level" | "active";

function reqTone(value: number, highlightLevel = false): ReqTone {
  if (value === 0) return "zero";
  return highlightLevel ? "level" : "active";
}

/** 計算卡片寬度：量出各區塊需要的最大寬，夾在 MIN_WIDTH～MAX_WIDTH。 */
function computeWidth(
  ctx: CanvasRenderingContext2D,
  details: ItemTooltip,
  text: TooltipText,
): number {
  let needed = MIN_WIDTH;
  const consider = (w: number) => {
    needed = Math.max(needed, w);
  };

  ctx.font = fontOf(800, 0.92);
  consider(ctx.measureText(text.title).width + PAD_X * 2);
  if (text.attributes) {
    ctx.font = fontOf(400, 0.7);
    consider(ctx.measureText(text.attributes).width + PAD_X * 2);
  }

  const pairWidth = (label: string, value: string): number => {
    ctx.font = fontOf(700, 0.62);
    const lw = ctx.measureText(label).width;
    ctx.font = fontOf(700, 0.78, true);
    return lw + 6 + ctx.measureText(value).width;
  };
  const lev = pairWidth(text.req.level, formatReq(details.requiredLevel));
  const row2 =
    pairWidth(text.req.str, formatReq(details.requiredStr)) +
    6 +
    pairWidth(text.req.luk, formatReq(details.requiredLuk));
  const row3 =
    pairWidth(text.req.dex, formatReq(details.requiredDex)) +
    6 +
    pairWidth(text.req.int, formatReq(details.requiredInt));
  consider(PAD_X + ICON_FRAME + 12 + Math.max(lev, row2, row3) + PAD_X);

  const jobWidths = text.jobs.map((job) => {
    ctx.font = fontOf(job.enabled ? 700 : 400, 0.72);
    return ctx.measureText(job.label).width;
  });
  consider(jobWidths.reduce((a, b) => a + b, 0) + 10 * (jobWidths.length - 1) + PAD_X * 2);

  ctx.font = fontOf(400, 0.78);
  consider(ctx.measureText(text.categoryLine).width + PAD_X * 2);
  const lines = [...text.stats, text.attackSpeed, text.scrollCount];
  for (const line of lines) {
    if (line) consider(ctx.measureText(`${line.label} : ${line.value}`).width + PAD_X * 2);
  }
  return Math.min(Math.max(Math.ceil(needed), MIN_WIDTH), MAX_WIDTH);
}

/**
 * 版型主體。draw=false 時只推進 y 並回傳總高（仍會設字體供 measureText），
 * draw=true 時實際繪製。顏色用 palette，分隔線用 textStrong 32% 漸層淡出。
 */
function layout(
  ctx: CanvasRenderingContext2D,
  width: number,
  details: ItemTooltip,
  text: TooltipText,
  icon: HTMLImageElement | null,
  palette: Palette,
  draw: boolean,
): number {
  let y = 0;
  const cx = width / 2;
  const paint = (fn: () => void) => {
    if (draw) fn();
  };
  const toneColor = (tone: ReqTone): Rgb =>
    tone === "zero" ? palette.subtle : tone === "level" ? palette.warning : palette.textStrong;

  // ── Header（id／標題／屬性，置中）──
  y += 9;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = fontOf(400, 0.66, true);
  ctx.fillStyle = css(palette.muted);
  paint(() => ctx.fillText(details.itemId, cx, y));
  y += lineHeight(0.66) + 1;
  ctx.font = fontOf(800, 0.92);
  ctx.fillStyle = css(palette.textStrong);
  paint(() => ctx.fillText(text.title, cx, y));
  y += lineHeight(0.92) + 1;
  if (text.attributes) {
    ctx.font = fontOf(400, 0.7);
    ctx.fillStyle = css(palette.warning);
    paint(() => ctx.fillText(text.attributes, cx, y));
    y += lineHeight(0.7) + 1;
  }
  y += 6;

  // ── Summary（左 icon 框、右 REQ 列）──
  y += 4;
  const rowH = lineHeight(0.78);
  const reqsH = rowH * 3 + 3 * 2;
  const summaryH = Math.max(ICON_FRAME, reqsH);
  const frameY = y + (summaryH - ICON_FRAME) / 2;
  const reqX = PAD_X + ICON_FRAME + 12;
  const reqW = width - reqX - PAD_X;
  const reqY = y + (summaryH - reqsH) / 2;

  paint(() => {
    ctx.beginPath();
    ctx.roundRect(PAD_X + 0.5, frameY + 0.5, ICON_FRAME - 1, ICON_FRAME - 1, 4);
    ctx.fillStyle = css(palette.panel);
    ctx.fill();
    ctx.strokeStyle = css(palette.border);
    ctx.lineWidth = 1;
    ctx.stroke();
    if (icon) {
      const { width: iw, height: ih } = iconDrawSize(icon);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        icon,
        PAD_X + (ICON_FRAME - iw) / 2,
        frameY + (ICON_FRAME - ih) / 2,
        iw,
        ih,
      );
    }
  });

  const reqRows: Array<Array<[string, string, ReqTone]>> = [
    [[text.req.level, formatReq(details.requiredLevel), reqTone(details.requiredLevel, true)]],
    [
      [text.req.str, formatReq(details.requiredStr), reqTone(details.requiredStr)],
      [text.req.luk, formatReq(details.requiredLuk), reqTone(details.requiredLuk)],
    ],
    [
      [text.req.dex, formatReq(details.requiredDex), reqTone(details.requiredDex)],
      [text.req.int, formatReq(details.requiredInt), reqTone(details.requiredInt)],
    ],
  ];
  ctx.textBaseline = "alphabetic";
  reqRows.forEach((row, ri) => {
    const baseline = reqY + ri * (rowH + 3) + rowH * 0.72;
    const cellW = (reqW - 6 * (row.length - 1)) / row.length;
    row.forEach(([label, value, tone], ci) => {
      const x0 = reqX + ci * (cellW + 6);
      ctx.font = fontOf(700, 0.62);
      ctx.fillStyle = css(palette.muted);
      ctx.textAlign = "left";
      paint(() => ctx.fillText(label, x0, baseline));
      ctx.font = fontOf(700, 0.78, true);
      ctx.fillStyle = css(toneColor(tone));
      ctx.textAlign = "right";
      paint(() => ctx.fillText(value, x0 + cellW, baseline));
    });
  });
  y += summaryH + 8;

  // ── 職業列（置中）──
  y += 5;
  const jobWidths = text.jobs.map((job) => {
    ctx.font = fontOf(job.enabled ? 700 : 400, 0.72);
    return ctx.measureText(job.label).width;
  });
  const jobsTotal = jobWidths.reduce((a, b) => a + b, 0) + 10 * (jobWidths.length - 1);
  let jobX = (width - jobsTotal) / 2;
  const jobBaseline = y + lineHeight(0.72) * 0.72;
  text.jobs.forEach((job, i) => {
    ctx.font = fontOf(job.enabled ? 700 : 400, 0.72);
    ctx.fillStyle = css(job.enabled ? palette.textStrong : palette.subtle);
    ctx.textAlign = "left";
    paint(() => ctx.fillText(job.label, jobX, jobBaseline));
    jobX += jobWidths[i] + 10;
  });
  y += lineHeight(0.72) + 7;

  const drawDivider = () => {
    paint(() => {
      const g = ctx.createLinearGradient(10, 0, width - 10, 0);
      g.addColorStop(0, css(palette.textStrong, 0));
      g.addColorStop(0.5, css(palette.textStrong, 0.32));
      g.addColorStop(1, css(palette.textStrong, 0));
      ctx.fillStyle = g;
      ctx.fillRect(10, y, width - 20, 1);
    });
    y += 1;
  };
  drawDivider();

  // ── 屬性明細（label muted + value textStrong；卷軸列整列 warning）──
  y += 7;
  const kvAdvance = lineHeight(0.78) + 1;
  const drawKV = (label: string, value: string, labelColor: Rgb, valueColor: Rgb) => {
    const baseline = y + lineHeight(0.78) * 0.72;
    ctx.font = fontOf(400, 0.78);
    ctx.textAlign = "left";
    ctx.fillStyle = css(labelColor);
    paint(() => ctx.fillText(label, PAD_X, baseline));
    if (value !== "") {
      const labelW = ctx.measureText(label).width;
      ctx.fillStyle = css(valueColor);
      paint(() => ctx.fillText(value, PAD_X + labelW, baseline));
    }
    y += kvAdvance;
  };
  drawKV(text.categoryLine, "", palette.muted, palette.muted);
  if (text.attackSpeed) {
    drawKV(`${text.attackSpeed.label} : `, text.attackSpeed.value, palette.muted, palette.textStrong);
  }
  for (const line of text.stats) {
    drawKV(`${line.label} : `, line.value, palette.muted, palette.textStrong);
  }
  if (text.scrollCount) {
    drawKV(`${text.scrollCount.label} : `, text.scrollCount.value, palette.warning, palette.warning);
  }
  y += 6;

  // ── 說明文字（muted、自動換行）──
  if (details.description) {
    drawDivider();
    y += 7;
    ctx.font = fontOf(400, 0.72);
    ctx.fillStyle = css(palette.muted);
    ctx.textAlign = "left";
    for (const line of wrapText(ctx, details.description, width - PAD_X * 2)) {
      paint(() => ctx.fillText(line, PAD_X, y + lineHeight(0.72) * 0.72));
      y += lineHeight(0.72);
    }
    y += 9;
  }

  return y;
}

/**
 * 把裝備 tooltip 依目前主題重繪成 PNG 並儲存。
 * 桌面版跳另存對話框（使用者自選路徑）；web 版觸發瀏覽器下載。
 */
export async function exportTooltipPng(source: ItemTooltip): Promise<void> {
  // 說明文字與畫面一致：還原字面 \n 換行，卷軸再把屬性逐條換行。
  const details = source.description
    ? { ...source, description: formatItemDescription(source.title, source.description) }
    : source;
  const icon = details.iconBase64 ? await loadIcon(details.iconBase64) : null;
  const palette = resolvePalette();

  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d");
  if (!mctx) throw new Error(t("tooltip.canvasFailed"));

  const text = tooltipText(details, t);
  const width = computeWidth(mctx, details, text);
  const height = Math.ceil(layout(mctx, width, details, text, icon, palette, false));

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * SCALE);
  canvas.height = Math.round(height * SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("tooltip.canvasFailed"));
  ctx.scale(SCALE, SCALE);

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, css(palette.surfaceRaised));
  bg.addColorStop(1, css(palette.surface));
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, width - 1, height - 1, CARD_RADIUS);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = css(palette.borderStrong);
  ctx.lineWidth = 1;
  ctx.stroke();

  layout(ctx, width, details, text, icon, palette, true);

  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const safeTitle = details.title.replace(/[\\/:*?"<>|]/g, "_");
  await saveBinaryFile(`item_${details.itemId}_${safeTitle}.png`, t("common.pngImage"), "png", base64);
}

/**
 * 非裝備戰利品 tooltip（左圖示、右側上名稱下描述）重繪成 PNG 並儲存；
 * 版型對齊 .drop-item-tooltip，分隔線同裝備版漸層。
 */
export async function exportDropItemTooltipPng(details: ItemTooltip): Promise<void> {
  const icon = details.iconBase64 ? await loadIcon(details.iconBase64) : null;
  const palette = resolvePalette();

  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d");
  if (!mctx) throw new Error(t("tooltip.canvasFailed"));

  // 資料裡的換行是字面 \n（對齊 monster.ts / skillJobs.ts）；卷軸另把屬性逐條換行。
  const description = details.description
    ? formatItemDescription(details.title, details.description)
    : null;

  // 文字欄寬：名稱與描述最長行取大，夾在下限～卡片上限。
  const textMax = DROP_MAX_WIDTH - PAD_X * 2 - ICON_FRAME - DROP_GAP;
  mctx.font = fontOf(800, 0.85);
  const title = tooltipTitle(details, t);
  let textW = mctx.measureText(title).width;
  if (description) {
    mctx.font = fontOf(400, 0.72);
    for (const line of description.split("\n")) {
      textW = Math.max(textW, mctx.measureText(line).width);
    }
  }
  textW = Math.ceil(Math.min(Math.max(textW, DROP_TEXT_MIN), textMax));
  const width = PAD_X * 2 + ICON_FRAME + DROP_GAP + textW;

  const descLines = description ? wrapText(mctx, description, textW) : [];
  const nameH = lineHeight(0.85);
  const textH =
    descLines.length > 0
      ? nameH + DROP_TEXT_GAP + 1 + DROP_TEXT_GAP + descLines.length * lineHeight(0.72)
      : nameH;
  const height = Math.ceil(DROP_PAD_Y * 2 + Math.max(ICON_FRAME, textH));

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * SCALE);
  canvas.height = Math.round(height * SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("tooltip.canvasFailed"));
  ctx.scale(SCALE, SCALE);

  // 卡片背景（同裝備版）。
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, css(palette.surfaceRaised));
  bg.addColorStop(1, css(palette.surface));
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, width - 1, height - 1, CARD_RADIUS);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = css(palette.borderStrong);
  ctx.lineWidth = 1;
  ctx.stroke();

  // 左：icon 框（垂直置中）。
  const frameY = (height - ICON_FRAME) / 2;
  ctx.beginPath();
  ctx.roundRect(PAD_X + 0.5, frameY + 0.5, ICON_FRAME - 1, ICON_FRAME - 1, 4);
  ctx.fillStyle = css(palette.panel);
  ctx.fill();
  ctx.strokeStyle = css(palette.border);
  ctx.stroke();
  if (icon) {
    const { width: iw, height: ih } = iconDrawSize(icon);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      icon,
      PAD_X + (ICON_FRAME - iw) / 2,
      frameY + (ICON_FRAME - ih) / 2,
      iw,
      ih,
    );
  }

  // 右：名稱、分隔線、描述（整欄垂直置中）。
  const textX = PAD_X + ICON_FRAME + DROP_GAP;
  let y = (height - textH) / 2;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = fontOf(800, 0.85);
  ctx.fillStyle = css(palette.textStrong);
  ctx.fillText(title, textX, y);
  y += nameH;
  if (descLines.length > 0) {
    y += DROP_TEXT_GAP;
    const divider = ctx.createLinearGradient(textX, 0, textX + textW, 0);
    divider.addColorStop(0, css(palette.textStrong, 0));
    divider.addColorStop(0.5, css(palette.textStrong, 0.32));
    divider.addColorStop(1, css(palette.textStrong, 0));
    ctx.fillStyle = divider;
    ctx.fillRect(textX, y, textW, 1);
    y += 1 + DROP_TEXT_GAP;
    ctx.font = fontOf(400, 0.72);
    ctx.fillStyle = css(palette.muted);
    for (const line of descLines) {
      ctx.fillText(line, textX, y);
      y += lineHeight(0.72);
    }
  }

  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const safeTitle = details.title.replace(/[\\/:*?"<>|]/g, "_");
  await saveBinaryFile(`item_${details.itemId}_${safeTitle}.png`, t("common.pngImage"), "png", base64);
}
