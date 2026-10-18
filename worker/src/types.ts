export interface Env extends Cloudflare.Env {
  RENDER_URL?: string;
  RENDER_SECRET?: string;
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
}

export interface JobRecord {
  id: string;
  owner: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  createdAt: number;
  expiresAt: number;
  items: JobItem[];
  inline?: boolean;
}
