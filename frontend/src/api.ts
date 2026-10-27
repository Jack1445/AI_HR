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
  created_at: string;
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
  communication_status: 'unknown' | 'outgoing' | 'incoming' | 'mutual';
  communication_checked_at: string | null;
  communication_evidence: { recruiter_sent: boolean; candidate_sent: boolean; request_resume_enabled: boolean | null; mutual_reply_required: boolean; attachment_present: boolean } | null;
  communication_error: string;
  communication_stale: boolean;
  updated_at: string;
}

export interface LocalCandidateListResponse { candidates: LocalCandidate[]; total: number; }
export interface LocalJob { id: string; remote_id: string; title: string; status: string; label: string; meta: string[]; stats: Record<string, number>; updated_at: string; }
export interface LocalJobListResponse { jobs: LocalJob[]; total: number; }
export interface SyncResponse { sync_id: string; scope: string; status: string; records_seen: number; records_written: number; error_summary: string; diagnostic_log?: string | null; since: string | null; verification_ids: string[]; history_summary: { scanned?: number; in_range?: number; undated?: number; unidentified?: number; ambiguous_legacy?: number; unmatched?: number }; }
export interface DebugEvent { time?: string; pid?: number; event?: string; elapsed_seconds?: number; details?: Record<string, unknown>; }
export interface TimingRow { stage: string; command?: string; status: string; elapsed_seconds: number; }
export interface DebugStatus {
  server_time: string;
  active_cli?: { command_id: string; command: string; diagnostic_log: string | null; elapsed_seconds: number } | null;
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
  diagnostics: { latest_log: string | null; sync_id?: string | null; events: DebugEvent[]; timings?: TimingRow[]; read_error?: string };
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
export async function syncLocal(scope = "all", options: { diagnostic?: boolean; since?: string } = {}): Promise<SyncResponse> {
  const query = new URLSearchParams({ scope });
  if (options.diagnostic) query.set("diagnostic", "true");
  if (options.since) query.set("since", options.since);
  return fetchJson<SyncResponse>(`/api/local/sync?${query.toString()}`, undefined, "同步失败", { method: "POST" });
}
export async function fetchCandidateDetail(id: string): Promise<CandidateDetail> { return fetchJson<CandidateDetail>(`/api/local/candidates/${encodeURIComponent(id)}`, undefined, "读取候选人详情失败"); }
export async function updateCandidate(id: string, body: Record<string, unknown>): Promise<CandidateDetail> { return fetchJson<CandidateDetail>(`/api/local/candidates/${encodeURIComponent(id)}`, undefined, "更新候选人失败", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
export async function matchCandidate(id: string, jobId: string): Promise<MatchResult> { return fetchJson<MatchResult>(`/api/candidates/${encodeURIComponent(id)}/match`, undefined, "匹配分析失败", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: jobId }) }); }
export async function createAction(body: Record<string, unknown>): Promise<ActionResponse> { return fetchJson<ActionResponse>("/api/actions", undefined, "创建动作失败", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
export async function confirmAction(id: string): Promise<ActionResponse> { return fetchJson<ActionResponse>(`/api/actions/${id}/confirm`, undefined, "确认动作失败", { method: "POST" }); }
export async function fetchPolicy(): Promise<AgentPolicy> { return fetchJson<AgentPolicy>("/api/agent/policy", undefined, "读取策略失败"); }
export async function fetchDebugStatus(signal?: AbortSignal): Promise<DebugStatus> { return fetchJson<DebugStatus>("/api/debug/status", signal, "读取调试状态失败"); }

export interface OnlineResumeScreenshot { id: string; image_url: string; captured_at: string; }
export interface RecommendedPerson { first_retrieved_at?: string | null; id: string; source_job: string; online_resume?: OnlineResumeScreenshot | null; geekId: string; name: string; salary: string; baseInfo: string; expect: string; experience: string; advantage: string; highlights: string[]; canGreet: boolean; hasHistoryChat: boolean; hasViewed: boolean; }
export interface RecommendationSnapshot { job_label: string; limit: number; candidates: RecommendedPerson[]; captured_at: string | null; stop_reason?: string; }
export interface RecommendationReadResult extends RecommendationSnapshot { added_ids: string[]; }
export interface RecycledRecommendation { job_key: string; scope_label: string; id: string; name: string; baseInfo: string; }
export interface RecommendationRecycleBin { candidates: RecycledRecommendation[]; }
export async function fetchRecommendationRecycleBin(signal?: AbortSignal, jobKey?: string): Promise<RecommendationRecycleBin> { return fetchJson<RecommendationRecycleBin>(`/api/local/recommendations/recycle-bin${jobKey ? `?job_key=${encodeURIComponent(jobKey)}` : ''}`, signal, '读取回收站失败'); }
export async function allowRecommendationAgain(id: string): Promise<void> { return fetchJson<void>(`/api/local/recommendations/recycle-bin/${encodeURIComponent(id)}/restore`, undefined, '允许重新读取失败', { method: 'POST' }); }
export async function fetchRecommendations(signal?: AbortSignal, jobKey?: string): Promise<RecommendationSnapshot> { return fetchJson<RecommendationSnapshot>(`/api/local/recommendations${jobKey ? `?job_key=${encodeURIComponent(jobKey)}` : ''}`, signal, '读取本地推荐快照失败'); }
export async function readRecommendations(jobKey: string): Promise<RecommendationReadResult> { return fetchJson<RecommendationReadResult>('/api/local/recommendations/read', undefined, '推荐读取失败', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_key: jobKey }) }); }
export async function deleteRecommendation(id: string): Promise<void> { return fetchJson<void>(`/api/local/recommendations/${encodeURIComponent(id)}`, undefined, '删除失败', { method: 'DELETE' }); }
export async function verifyCommunications(ids: string[]): Promise<LocalCandidateListResponse> { return fetchJson<LocalCandidateListResponse>('/api/local/communications/verify', undefined, '核验沟通状态失败', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidate_ids: ids }) }); }

export async function fetchJson<T>(path: string, signal: AbortSignal | undefined, fallbackMessage: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, signal });
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { detail?: string };
      detail = typeof body.detail === 'string' ? body.detail : body.detail ? JSON.stringify(body.detail) : '';
    } catch {
      detail = "";
    }
    throw new Error(detail ? `${fallbackMessage}：${detail}` : `${fallbackMessage}（HTTP ${response.status}）`);
  }
  return response.status === 204 ? undefined as T : (await response.json()) as T;
}

export async function captureRecommendedResume(geekId: string, candidateId: string): Promise<OnlineResumeScreenshot> { return fetchJson<OnlineResumeScreenshot>('/api/local/recommendations/resume', undefined, '读取在线简历失败', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geek_id: geekId, candidate_id: candidateId }) }); }
export function resumeScreenshotUrl(screenshot: OnlineResumeScreenshot): string { return `${apiBaseUrl}${screenshot.image_url}`; }

export async function fetchAllLocalCandidates(params: Record<string, string | undefined> = {}, signal?: AbortSignal): Promise<LocalCandidateListResponse> {
  const candidates: LocalCandidate[] = [];
  let total = 0;
  do {
    const batch = await fetchLocalCandidates({ ...params, limit: '500', offset: String(candidates.length) }, signal);
    candidates.push(...batch.candidates); total = batch.total;
    if (!batch.candidates.length && candidates.length < total) throw new Error("候选人列表未读取完整，请重试，尚未开始全量核验");
  } while (candidates.length < total);
  return { candidates, total };
}
export const updateCandidateTags = (id: string, tags: string[]) => fetchJson<CandidateDetail>(`/api/local/candidates/${encodeURIComponent(id)}/tags`, undefined, '保存标签失败', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }) });

export interface RecommendationJob { id: string; label: string; available: boolean; count: number }
export interface RecommendationJobs { jobs: RecommendationJob[]; current_job_key?: string }
export const fetchRecommendationJobs = (signal?: AbortSignal) => fetchJson<RecommendationJobs>('/api/local/recommendations/jobs', signal, '读取本地推荐岗位失败');
export const readRecommendationJobs = () => fetchJson<RecommendationJobs>('/api/local/recommendations/jobs/read', undefined, '刷新 BOSS 推荐岗位失败', { method: 'POST' });
