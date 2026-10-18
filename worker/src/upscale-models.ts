// Worker mirror of the server model whitelist.
//
// Single source of truth is server/src/upscale/models.js (ids, scales, sizes).
// The worker cannot import it (server modules pull in onnxruntime-node/sharp),
// so only the ids/scales are duplicated here. Keep in sync by hand: ids must
// match exactly, and unknown ids must always error with the full list (never a
// silent fallback).

export interface UpscaleModel {
  id: string;
  name: string;
  scale: number;
  sizeMB: number;
}

export const UPSCALE_MODELS: UpscaleModel[] = [
  {
    id: 'general-x4v3',
    name: 'Real-ESRGAN General x4v3',
    scale: 4,
    sizeMB: 4.9,
  },
  { id: 'anime-v3', name: 'Real-ESRGAN AnimeVideo v3', scale: 4, sizeMB: 2.5 },
  { id: 'cugan-2x', name: 'Real-CUGAN 2x (HFA2k)', scale: 2, sizeMB: 5.2 },
  {
    id: 'swin-light-x2',
    name: 'Swin2SR Lightweight x2',
    scale: 2,
    sizeMB: 8.1,
  },
];

export const DEFAULT_UPSCALE_MODEL = 'general-x4v3';

export function findUpscaleModel(
  id: string | undefined,
): UpscaleModel | undefined {
  return UPSCALE_MODELS.find((m) => m.id === id);
}

export function upscaleModelIds(): string {
  return UPSCALE_MODELS.map((m) => m.id).join(', ');
}

export function unknownModelMessage(id: unknown): string {
  return `unknown model "${id}". Available: ${upscaleModelIds()}.`;
}

/** Input megapixel budget per model scale — same numbers as the server. */
export function mpBudget(scale: number): number {
  return scale === 4 ? 2 : 4;
}
