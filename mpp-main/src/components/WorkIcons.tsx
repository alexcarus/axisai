// Minimal line icons for the seven PoAIW work types. Monochrome, 24px grid,
// 1.5 stroke — replaces emoji for a more considered, brand-grade look.

import type { ReactNode } from "react";

const COMMON = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const PATHS: Record<string, ReactNode> = {
  inference_text: (
    <>
      <path d="M5 7h14" />
      <path d="M5 12h14" />
      <path d="M5 17h9" />
    </>
  ),
  inference_image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <circle cx="8.5" cy="9.5" r="1.4" />
      <path d="M4 16.5l4.5-3.5 3.5 2.5 3-2 5 4" />
    </>
  ),
  inference_audio: (
    <>
      <path d="M4 10v4" />
      <path d="M8 7.5v9" />
      <path d="M12 5v14" />
      <path d="M16 8.5v7" />
      <path d="M20 10.5v3" />
    </>
  ),
  training_step: (
    <>
      <path d="M4 5v15h16" />
      <path d="M6.5 16.5c3 0 4-7 7-7s2.5 4 4.5 4" />
    </>
  ),
  dataset_labeling: (
    <>
      <path d="M3.6 9.2l5.6-5.6H18a2 2 0 0 1 2 2v8.8l-5.6 5.6a2 2 0 0 1-2.8 0L3.6 12a2 2 0 0 1 0-2.8z" />
      <circle cx="15.5" cy="8.5" r="1.2" />
    </>
  ),
  synthetic_data_generation: (
    <>
      <path d="M4 19c2-9 6-9 8 0" opacity="0.55" />
      <circle cx="7.5" cy="14.5" r="1" />
      <circle cx="12" cy="9" r="1" />
      <circle cx="16.5" cy="13" r="1" />
      <circle cx="10" cy="16.5" r="1" />
      <circle cx="14.5" cy="16" r="1" />
    </>
  ),
  peer_validation: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.5l2.4 2.4 4.6-5" />
    </>
  ),
};

export function WorkIcon({
  id,
  size = 22,
}: {
  id: string;
  size?: number;
}) {
  const path = PATHS[id] ?? PATHS.inference_text;
  return (
    <svg {...COMMON} width={size} height={size} aria-hidden="true">
      {path}
    </svg>
  );
}
