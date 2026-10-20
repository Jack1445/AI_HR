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
  id?: string;
  name: string;
  job: string;
  time: string;
  message: string;
  unread_count: number;
}

export interface LocalCandidate {
  id: string;
  remote_id: string;
  name: string;
  stage: string;
  owner: string;
  favorite: boolean;
  follow_up_at: string | null;
  job_ids: string[];
  job_titles: string[];
  latest_message: string;
  latest_time: string;
  unread_count: number;
  tags: string[];
  updated_at: string;
}

export interface LocalCandidateListResponse { candidates: LocalCandidate[]; total: number; }
export interface LocalJob { id: string; remote_id: string; title: string; status: string; label: string; meta: string[]; stats: Record<string, number>; updated_at: string; }
export interface LocalJobListResponse { jobs: LocalJob[]; total: number; }
export interface SyncResponse { sync_id: string; scope: string; status: string; records_seen: number; records_written: number; error_summary: string; diagnostic_log?: string | null; }
export interface DebugEvent { time?: string; pid?: number; event?: string; details?: Record<string, unknown>; }
export interface DebugStatus {
  server_time: string;
  runtime: { pid: number; python: string; platform: string; cwd: string };
  config: {
    boss_cli_command: string;
    boss_cli_entrypoint: string;
    boss_cli_entrypoint_resolved: string;
    boss_cli_entrypoint_exists: boolean;
    boss_cli_timeout_seconds: number;
    boss_enable_writes: boolean;
    automation_emergency_stop: boolean;
    data_dir: string;
    data_dir_exists: boolean;
    database_kind: string;
  };
  latest_sync: {
    id: string;
    scope: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    records_seen: number;
    records_written: number;
    error_summary: string;
  } | null;
  diagnostics: { latest_log: string | null; events: DebugEvent[]; read_error?: string };
}
export interface CandidateDetail extends LocalCandidate { profile: Record<string, unknown>; notes: Array<Record<string, unknown>>; stage_history: Array<Record<string, unknown>>; timeline: Array<Record<string, unknown>>; }
export interface MatchResult { analysis_id: string; candidate_id: string; job_id: string; provider: string; model: string; score: number; recommendation: string; must_haves: Array<Record<string, unknown>>; strengths: string[]; risks: string[]; questions: string[]; evidence: Array<Record<string, unknown>>; generated_at: string; }
export interface ActionResponse { id: string; action_type: string; status: string; candidate_id: string; job_id: string | null; payload: Record<string, unknown>; result: Record<string, unknown>; created_by: string; confirmed_by: string; created_at: string; updated_at: string; }
export interface AgentPolicy { read_scopes: string[]; write_scopes: string[]; writes_enabled: boolean; emergency_stop: boolean; confirmation_required: boolean; batch_limit: number; }

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

export async function fetchLocalJobs(signal?: AbortSignal): Promise<LocalJobListResponse> { return fetchJson<LocalJobListResponse>("/api/local/jobs", signal, "读取本地岗位失败"); }
export async function fetchLocalCandidates(params: Record<string, string | undefined> = {}, signal?: AbortSignal): Promise<LocalCandidateListResponse> {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value) as [string, string][]).toString();
  return fetchJson<LocalCandidateListResponse>(`/api/local/candidates${query ? `?${query}` : ""}`, signal, "读取本地候选人失败");
}
export async function syncLocal(scope = "all", options: { diagnostic?: boolean } = {}): Promise<SyncResponse> {
  const query = new URLSearchParams({ scope });
  if (options.diagnostic) query.set("diagnostic", "true");
  return fetchJson<SyncResponse>(`/api/local/sync?${query.toString()}`, undefined, "同步失败", { method: "POST" });
}
export async function fetchCandidateDetail(id: string): Promise<CandidateDetail> { return fetchJson<CandidateDetail>(`/api/local/candidates/${encodeURIComponent(id)}`, undefined, "读取候选人详情失败"); }
export async function updateCandidate(id: string, body: Record<string, unknown>): Promise<CandidateDetail> { return fetchJson<CandidateDetail>(`/api/local/candidates/${encodeURIComponent(id)}`, undefined, "更新候选人失败", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
export async function matchCandidate(id: string, jobId: string): Promise<MatchResult> { return fetchJson<MatchResult>(`/api/candidates/${encodeURIComponent(id)}/match`, undefined, "匹配分析失败", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: jobId }) }); }
export async function createAction(body: Record<string, unknown>): Promise<ActionResponse> { return fetchJson<ActionResponse>("/api/actions", undefined, "创建动作失败", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
export async function confirmAction(id: string): Promise<ActionResponse> { return fetchJson<ActionResponse>(`/api/actions/${id}/confirm`, undefined, "确认动作失败", { method: "POST" }); }
export async function fetchPolicy(): Promise<AgentPolicy> { return fetchJson<AgentPolicy>("/api/agent/policy", undefined, "读取策略失败"); }
export async function fetchDebugStatus(): Promise<DebugStatus> { return fetchJson<DebugStatus>("/api/debug/status", undefined, "读取调试状态失败"); }

async function fetchJson<T>(path: string, signal: AbortSignal | undefined, fallbackMessage: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, signal });
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
