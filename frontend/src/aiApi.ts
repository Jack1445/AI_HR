export interface AIConfig {
  base_url: string; model: string; temperature: number | null; max_tokens: number;
  token_parameter: 'max_completion_tokens' | 'max_tokens'; timeout_seconds: number;
  send_session_id: boolean;
  prompt: string; has_key: boolean;
}
export interface AIJobPrompt { job_key: string; job_label: string; prompt: string; custom: boolean; jd: string }
export interface AISelection {
  source: 'recommendations' | 'communications'; job_id: string; candidate_ids: string[];
  include_images: boolean; job_context: string;
}
export interface AIModelList { models: { id: string }[]; endpoint: string }
export interface AICatalog {
  jobs: { id: string; label: string; count: number }[];
  candidates: { id: string; name: string; summary: string; job: string; has_image: boolean }[];
}
export interface AIItem {
  candidate_id: string; name: string; data: Record<string, unknown>; image_id: string | null;
  status: string; output: string; error: string; usage: Record<string, number>;
  elapsed_seconds: number | null; truncated?: boolean;
}
export interface AIRun {
  id: string; status: string; model: string; created_at: string; finished_at: string | null;
  total: number; completed: number; failed: number; error: string;
  selection: AISelection; config?: AIConfig; items?: AIItem[];
}
export interface AIRecommendationResult {
  candidate_id: string; run_id: string; stars: number; model: string; created_at: string; output?: string;
}
const base = import.meta.env.VITE_API_BASE_URL ?? '';
export function aiImage(id: string) { return `${base}/api/local/recommendation-resumes/${id}/image`; }
export async function aiRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${base}/api/ai${path}`, { method, signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    // Validation responses can include submitted values: show only messages.
    const detail = typeof error.detail === 'string' ? error.detail : Array.isArray(error.detail) ? error.detail.map((x: { msg?: string }) => x.msg).filter(Boolean).join('；') : '';
    throw new Error(detail || `请求失败（HTTP ${response.status}）`);
  }
  return response.json() as Promise<T>;
}
