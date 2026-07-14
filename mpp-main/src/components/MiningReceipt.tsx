"use client";

// ---------------------------------------------------------------------------
// Shareable "proof-of-mining" receipt. Turns a mining session into a branded
// card image the user can share to X / Telegram / anywhere — every share is
// free, organic reach. Reusable for compute receipts too (pass a label).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { shortAddress } from "../lib/axis";

const SITE = "https://axismyai.com";

function shareText(axisStr: string, verb: string): string {
  return (
    `I just ${verb} ${axisStr} AXIS by doing real AI work ⛏\n\n` +
    `Proof-of-AI-Work · fair launch · 84,000,000 fixed supply, no premine, no admin keys. ` +
    `Mine it free in your browser or on Telegram 👇`
  );
}

type CardData = {
  axisStr: string;
  blocks: number;
  addr: string;
  epoch: string | null;
  verb: string;
};

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(251,191,36,0.85)";
  ctx.shadowBlur = 42;
  for (let a = 0; a < 360; a += 45) {
    const rad = (a * Math.PI) / 180;
    const axis = a % 90 === 0;
    ctx.strokeStyle = axis ? "#ffffff" : "#e8eaf0";
    ctx.lineWidth = axis ? 15 : 12;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * r, cy + Math.sin(rad) * r);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.13, 0, 2 * Math.PI);
  ctx.fill();
}

function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  start: number,
): number {
  let px = start;
  while (px > 48) {
    ctx.font = `800 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    if (ctx.measureText(text).width <= maxW) break;
    px -= 6;
  }
  return px;
}

function drawCard(cv: HTMLCanvasElement, d: CardData) {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const W = 1080;
  const H = 1080;
  const P = 92;
  ctx.fillStyle = "#0a0b0d";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(330, 360, 0, 330, 360, 720);
  glow.addColorStop(0, "rgba(251,191,36,0.18)");
  glow.addColorStop(1, "rgba(251,191,36,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.09)";
  ctx.lineWidth = 2;
  ctx.strokeRect(44, 44, W - 88, H - 88);

  drawStar(ctx, 176, 214, 78);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#eef1f6";
  ctx.font = '700 46px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText("AXIS AI", 286, 204);
  ctx.fillStyle = "#fbbf24";
  ctx.font = '600 27px ui-monospace, "SFMono-Regular", monospace';
  ctx.fillText("PROOF-OF-AI-WORK", 288, 248);

  const px = fitFont(ctx, d.axisStr, W - 2 * P, 214);
  ctx.font = `800 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillStyle = "#f6f8fc";
  ctx.fillText(d.axisStr, P, 620);
  ctx.fillStyle = "#fbbf24";
  ctx.font = '700 58px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(`AXIS ${d.verb}`, P + 4, 704);
  ctx.fillStyle = "#9aa1ad";
  ctx.font = '500 36px system-ui, -apple-system, "Segoe UI", sans-serif';
  const sub = `${d.blocks} block${d.blocks === 1 ? "" : "s"} of verified AI work${d.epoch ? ` · ${d.epoch}` : ""}`;
  ctx.fillText(sub, P + 4, 770);

  ctx.strokeStyle = "rgba(255,255,255,0.09)";
  ctx.beginPath();
  ctx.moveTo(P, 902);
  ctx.lineTo(W - P, 902);
  ctx.stroke();
  ctx.fillStyle = "#6b7280";
  ctx.font = '500 30px ui-monospace, "SFMono-Regular", monospace';
  ctx.fillText(d.addr, P, 966);
  ctx.fillStyle = "#eef1f6";
  ctx.font = '700 42px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText("axismyai.com", P, 1016);
  ctx.textAlign = "right";
  ctx.fillStyle = "#6b7280";
  ctx.font = '500 27px ui-monospace, "SFMono-Regular", monospace';
  ctx.fillText("84,000,000 fixed · no premine", W - P, 1016);
  ctx.textAlign = "left";
}

export function MiningReceipt({
  axisEarned,
  blocks,
  address,
  epoch = null,
  verb = "mined",
  onClose,
}: {
  axisEarned: number;
  blocks: number;
  address: string;
  epoch?: string | null;
  verb?: string;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const axisStr = axisEarned.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    drawCard(cv, { axisStr, blocks, addr: shortAddress(address), epoch, verb });
    setDataUrl(cv.toDataURL("image/png"));
  }, [axisStr, blocks, address, epoch, verb]);

  const download = useCallback(() => {
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "axis-receipt.png";
    a.click();
  }, [dataUrl]);

  const share = useCallback(async () => {
    const cv = canvasRef.current;
    const text = shareText(axisStr, verb);
    const blob = cv
      ? await new Promise<Blob | null>((r) => cv.toBlob(r, "image/png"))
      : null;
    const file = blob
      ? new File([blob], "axis-receipt.png", { type: "image/png" })
      : null;
    // Native share with the image (mobile + Telegram webview) — the strongest path.
    if (file && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text, url: SITE });
        return;
      } catch {
        /* user cancelled or unsupported — fall through */
      }
    }
    download();
  }, [axisStr, verb, download]);

  const postX = useCallback(() => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText(axisStr, verb))}&url=${encodeURIComponent(SITE)}`;
    window.open(url, "_blank", "noopener");
  }, [axisStr, verb]);

  return (
    <div className="axr-overlay">
      <style>{`
        .axr-overlay { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center;
          justify-content: center; padding: 18px; background: rgba(0,0,0,0.72); backdrop-filter: blur(4px); }
        .axr-scrim { position: absolute; inset: 0; border: none; background: transparent; cursor: default; padding: 0; }
        .axr-modal { position: relative; z-index: 1; width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 12px; }
        .axr-canvas { width: 100%; height: auto; border-radius: 14px; border: 1px solid rgba(255,255,255,0.1);
          box-shadow: 0 30px 80px -30px rgba(0,0,0,0.8); }
        .axr-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
        .axr-btn { padding: 11px 8px; border-radius: 9px; font-size: 12.5px; font-weight: 700; cursor: pointer;
          border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.04); color: #eef1f6;
          font-family: var(--font-sans, system-ui, sans-serif); }
        .axr-primary { background: #fbbf24; border-color: #fbbf24; color: #0a0b0d; }
        .axr-close { align-self: center; background: none; border: none; color: rgba(255,255,255,0.6);
          font-size: 13px; cursor: pointer; padding: 4px 10px; font-family: var(--font-sans, system-ui, sans-serif); }
      `}</style>
      <button
        type="button"
        className="axr-scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="axr-modal">
        <canvas
          ref={canvasRef}
          width={1080}
          height={1080}
          className="axr-canvas"
        />
        <div className="axr-actions">
          <button
            type="button"
            className="axr-btn axr-primary"
            onClick={() => void share()}
          >
            Share
          </button>
          <button type="button" className="axr-btn" onClick={postX}>
            Post to X
          </button>
          <button type="button" className="axr-btn" onClick={download}>
            Save
          </button>
        </div>
        <button type="button" className="axr-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
