export interface Env {
  ASSETS: Fetcher;
  BUCKET: R2Bucket;
  JOBS: KVNamespace;
  QUEUE: Queue<any>;
  RENDER_URL?: string;
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
