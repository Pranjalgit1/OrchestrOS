import { env } from "../../config/env.js";
import {
  CONTAINER_LABEL_MANAGED,
  CONTAINER_STOP_TIMEOUT_SECONDS,
  WORKLOAD_IMAGE,
  buildRunnerEnvironment,
  containerNameFor,
} from "./execution.contract.js";
import { DockerEngineClient, DockerTimeoutError } from "./docker.client.js";
/**
 * Builds the container specification.
 *
 * Every field is decided here; nothing is taken from a request. The container
 * gets no network, a read-only root filesystem, no capabilities, no privilege
 * escalation, a PID ceiling, and CPU/memory limits equal to the resources the
 * job actually reserved.
 */
export function buildContainerSpec(plan) {
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
export class DockerContainerRuntime {
  client;
  logLimitBytes;
  constructor(
    client = new DockerEngineClient(env.DOCKER_SOCKET_PATH),
    logLimitBytes = env.EXECUTION_LOG_LIMIT_BYTES,
  ) {
    this.client = client;
    this.logLimitBytes = logLimitBytes;
  }
  async describe() {
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
  async start(plan) {
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
  async isRunning(containerId) {
    const state = await this.client.inspectContainer(containerId);
    return state.status === "running" || state.status === "created";
  }
  async waitForExit(containerId, timeoutMs) {
    try {
      await this.client.waitContainer(containerId, timeoutMs);
      return { timedOut: false };
    } catch (error) {
      if (!(error instanceof DockerTimeoutError)) throw error;
      // The timeout is OrchestrOS policy, so it stops the container itself.
      await this.client.stopContainer(
        containerId,
        CONTAINER_STOP_TIMEOUT_SECONDS,
      );
      return { timedOut: true };
    }
  }
  async collect(containerId) {
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
  remove(containerId) {
    return this.client.removeContainer(containerId);
  }
}
export const dockerContainerRuntime = new DockerContainerRuntime();
