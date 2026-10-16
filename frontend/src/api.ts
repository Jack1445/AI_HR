export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  timestamp: string;
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(`${apiBaseUrl}/api/health`, { signal });
  if (!response.ok) {
    throw new Error(`健康检查失败（HTTP ${response.status}）`);
  }
  return (await response.json()) as HealthResponse;
}
