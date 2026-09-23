import type { WorkloadType } from "@prisma/client";

import { env } from "../../config/env.js";
import {
  CONTAINER_LABEL_MANAGED,
  CONTAINER_STOP_TIMEOUT_SECONDS,
  WORKLOAD_IMAGE,
  buildRunnerEnvironment,
  containerNameFor,
} from "./execution.contract.js";
import {
  DockerEngineClient,
  DockerTimeoutError,
  type ContainerCreateSpec,
} from "./docker.client.js";

/** Everything needed to run one workload container. */
export interface ExecutionPlan {
  executionId: string;
  jobId: string;
  jobName: string;
  workerId: string;
  allocationId: string;
  workloadType: WorkloadType;
  workloadSize: number;
  cpuMillicores: number;
  memoryMiB: number;
  seed: number;
}

export interface StartedContainer {
  containerId: string;
  containerName: string;
}

export interface ContainerExit {
  exitCode: number;
  oomKilled: boolean;
  daemonError: string;
  startedAt: string | null;
  finishedAt: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RuntimeDescription {
  serverVersion: string;
  apiVersion: string;
  image: string;
  imageAvailable: boolean;
  socketPath: string;
}

export interface ContainerRuntime {
  describe(): Promise<RuntimeDescription>;
  start(plan: ExecutionPlan): Promise<StartedContainer>;
  /** True while the container is still executing. */
  isRunning(containerId: string): Promise<boolean>;
  /** Blocks until exit; stops the container and reports `timedOut` on expiry. */
  waitForExit(containerId: string, timeoutMs: number): Promise<{ timedOut: boolean }>;
  /** Reads the final state and captured output. */
  collect(containerId: string): Promise<ContainerExit>;
  remove(containerId: string): Promise<void>;
}

/**
 * Builds the container specification.
 *
 * Every field is decided here; nothing is taken from a request. The container
 * gets no network, a read-only root filesystem, no capabilities, no privilege
 * escalation, a PID ceiling, and CPU/memory limits equal to the resources the
 * job actually reserved.
 */
export function buildContainerSpec(plan: ExecutionPlan): ContainerCreateSpec {
  return {
    Image: WORKLOAD_IMAGE,
    Env: buildRunnerEnvironment({
      workloadType: plan.workloadType,
      workloadSize: plan.workloadSize,
      seed: plan.seed,
      memoryMiB: plan.memoryMiB,
    }),
    Labels: {
      [CONTAINER_LABEL_MANAGED]: "true",
      "orchestros.job.id": plan.jobId,
      "orchestros.job.name": plan.jobName,
      "orchestros.execution.id": plan.executionId,
      "orchestros.worker.id": plan.workerId,
      "orchestros.allocation.id": plan.allocationId,
    },
    NetworkDisabled: true,
    HostConfig: {
      // The container is capped at exactly what the job reserved.
      Memory: plan.memoryMiB * 1024 * 1024,
      MemorySwap: plan.memoryMiB * 1024 * 1024,
      NanoCpus: plan.cpuMillicores * 1_000_000,
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: 64,
      // Kept until OrchestrOS has read the exit code and logs, then removed.
      AutoRemove: false,
      Privileged: false,
      Binds: [],
      RestartPolicy: { Name: "no" },
    },
  };
}

export class DockerContainerRuntime implements ContainerRuntime {
  constructor(
    private readonly client = new DockerEngineClient(env.DOCKER_SOCKET_PATH),
    private readonly logLimitBytes = env.EXECUTION_LOG_LIMIT_BYTES,
  ) {}

  async describe(): Promise<RuntimeDescription> {
    const version = await this.client.version();
    const imageAvailable = await this.client.imageExists(WORKLOAD_IMAGE);
    return {
      serverVersion: version.serverVersion,
      apiVersion: version.apiVersion,
      image: WORKLOAD_IMAGE,
      imageAvailable,
      socketPath: env.DOCKER_SOCKET_PATH,
    };
  }

  async start(plan: ExecutionPlan): Promise<StartedContainer> {
    const containerName = containerNameFor(plan.executionId);
    const containerId = await this.client.createContainer(
      containerName,
      buildContainerSpec(plan),
    );

    try {
      await this.client.startContainer(containerId);
    } catch (error) {
      // A container that was created but never started must not be left behind.
      await this.client.removeContainer(containerId).catch(() => undefined);
      throw error;
    }

    return { containerId, containerName };
  }

  async isRunning(containerId: string): Promise<boolean> {
    const state = await this.client.inspectContainer(containerId);
    return state.status === "running" || state.status === "created";
  }

  async waitForExit(containerId: string, timeoutMs: number): Promise<{ timedOut: boolean }> {
    try {
      await this.client.waitContainer(containerId, timeoutMs);
      return { timedOut: false };
    } catch (error) {
      if (!(error instanceof DockerTimeoutError)) throw error;
      // The timeout is OrchestrOS policy, so it stops the container itself.
      await this.client.stopContainer(containerId, CONTAINER_STOP_TIMEOUT_SECONDS);
      return { timedOut: true };
    }
  }

  async collect(containerId: string): Promise<ContainerExit> {
    const state = await this.client.inspectContainer(containerId);
    const logs = await this.client.readLogs(containerId, this.logLimitBytes);

    return {
      exitCode: state.exitCode ?? -1,
      oomKilled: state.oomKilled,
      daemonError: state.error,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      stdout: logs.stdout,
      stderr: logs.stderr,
      stdoutTruncated: logs.stdoutTruncated,
      stderrTruncated: logs.stderrTruncated,
    };
  }

  remove(containerId: string): Promise<void> {
    return this.client.removeContainer(containerId);
  }
}

export const dockerContainerRuntime = new DockerContainerRuntime();
