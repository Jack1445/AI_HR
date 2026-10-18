export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  timestamp: string;
}

export interface JobStats {
  viewed: number;
  chatted: number;
  interested: number;
}

export interface Job {
  id: string;
  title: string;
  status: string;
  label: string;
  meta: string[];
  stats: JobStats;
}

export interface Candidate {
  name: string;
  job: string;
  time: string;
  message: string;
  unread_count: number;
}

export interface JobListResponse {
  jobs: Job[];
  remote_total: number | null;
  source: string;
  read_only: boolean;
}

export interface CandidateListResponse {
  job_id: string;
  job_title: string;
  candidates: Candidate[];
  remote_total: number | null;
  unread_total: number | null;
  source: string;
  semantics: string;
  read_only: boolean;
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return fetchJson<HealthResponse>("/api/health", signal, "健康检查失败");
}

export async function fetchJobs(signal?: AbortSignal): Promise<JobListResponse> {
  return fetchJson<JobListResponse>("/api/jobs", signal, "读取岗位失败");
}

export async function fetchCandidates(jobId: string, signal?: AbortSignal): Promise<CandidateListResponse> {
  return fetchJson<CandidateListResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}/candidates`,
    signal,
    "读取候选人失败",
  );
}

async function fetchJson<T>(path: string, signal: AbortSignal | undefined, fallbackMessage: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { signal });
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { detail?: string };
      detail = body.detail ?? "";
    } catch {
      detail = "";
    }
    throw new Error(detail ? `${fallbackMessage}：${detail}` : `${fallbackMessage}（HTTP ${response.status}）`);
  }
  return (await response.json()) as T;
}
