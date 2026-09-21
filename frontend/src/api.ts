export interface HealthStatus {
  service: string;
  status: "ok" | "degraded";
  timestamp: string;
  dependencies: {
    database: "up" | "down";
  };
}

export async function fetchHealthStatus(signal?: AbortSignal): Promise<HealthStatus> {
  const response = await fetch("/api/health", { signal });
  const body = (await response.json()) as HealthStatus;

  if (!response.ok && response.status !== 503) {
    throw new Error(`Backend health check returned ${response.status}`);
  }

  return body;
}
