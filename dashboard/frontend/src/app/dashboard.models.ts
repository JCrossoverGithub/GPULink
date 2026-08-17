export interface DashboardSnapshot {
  generatedAt: string;
  controlPlane: {
    status: string;
  };
  summary: DashboardSummary;
  jobsByStatus: Record<string, number>;
  workers: Worker[];
  jobs: Job[];
}

export interface DashboardSummary {
  workersTotal: number;
  workersOnline: number;
  workersDrained: number;
  gpusTotal: number;
  memoryTotalMiB: number;
  memoryUsedMiB: number;
  jobsTotal: number;
  jobsQueued: number;
  jobsRunning: number;
  jobsFailed: number;
}

export interface Worker {
  id: string;
  name: string;
  version: string;
  status: string;
  drainMode: boolean;
  labels: Record<string, string>;
  capabilities: string[];
  warmModels: string[];
  gpus: Gpu[];
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface Gpu {
  uuid: string;
  index: number;
  name: string;
  memoryTotalMiB: number;
  memoryUsedMiB: number;
  utilizationPercent: number;
  temperatureC: number;
  powerDrawWatts: number | null;
}

export interface Job {
  id: string;
  projectId: string;
  type: string;
  priority: number;
  status: string;
  assignedWorkerId: string | null;
  assignedGpuUuid: string | null;
  attempt: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
}
