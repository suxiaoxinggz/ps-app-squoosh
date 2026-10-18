export interface Env extends Cloudflare.Env {
  RENDER_URL?: string;
  RENDER_SECRET?: string;
}

export type JobKindName = 'compress' | 'upscale';

/** One shard of an upscale job: one POST /upscale/tile call. */
export interface UpscaleTile {
  tx: number;
  ty: number;
  status: 'queued' | 'done' | 'error';
  patchKey?: string;
  ow?: number;
  oh?: number;
  size?: number;
  error?: string;
}

export interface JobItem {
  id: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  inputKey: string;
  outputKey?: string;
  format?: string;
  options?: any;
  error?: string;
  size?: number;
  mime?: string;
  // ---- upscale only ----
  /** Model id (see upscale-models.ts). */
  model?: string;
  /** Model native scale (2 or 4). */
  scale?: number;
  /** Effective output scale (targetScale, default = scale). */
  targetScale?: number;
  width?: number;
  height?: number;
  /** Input megapixels. */
  mp?: number;
  tilesX?: number;
  tilesY?: number;
  /** Per-tile state, filled by the plan phase. */
  tiles?: UpscaleTile[];
}

export interface JobRecord {
  id: string;
  owner: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  createdAt: number;
  expiresAt: number;
  items: JobItem[];
  inline?: boolean;
  kind?: JobKindName;
}
