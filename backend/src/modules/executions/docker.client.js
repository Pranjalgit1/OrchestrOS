import http from "node:http";
/**
 * Minimal Docker Engine API transport.
 *
 * Only the endpoints OrchestrOS needs are exposed, and every call goes over the
 * local daemon socket. No npm Docker client is used: the surface is small enough
 * that a hand-written adapter keeps the reachable API explicit and auditable.
 */
/** Highest API version this adapter is written against. */
const PREFERRED_API_VERSION = "1.44";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Docker multiplexes non-TTY output into frames with an 8 byte header. */
const LOG_FRAME_HEADER_BYTES = 8;
const LOG_STREAM_STDOUT = 1;
const LOG_STREAM_STDERR = 2;
export class DockerApiError extends Error {
  statusCode;
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.name = "DockerApiError";
  }
}
export class DockerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "DockerUnavailableError";
  }
}
export class DockerTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "DockerTimeoutError";
  }
}
function parseVersionParts(version) {
  const [major, minor] = version.split(".");
  return [Number(major ?? 0), Number(minor ?? 0)];
}
function compareVersions(left, right) {
  const [leftMajor, leftMinor] = parseVersionParts(left);
  const [rightMajor, rightMinor] = parseVersionParts(right);
  if (leftMajor !== rightMajor) return leftMajor - rightMajor;
  return leftMinor - rightMinor;
}
/**
 * Picks the newest API version both sides understand: never newer than what this
 * adapter was written against, never older than the daemon still accepts.
 */
export function negotiateApiVersion(
  daemonApiVersion,
  daemonMinApiVersion,
  preferred = PREFERRED_API_VERSION,
) {
  const ceiling =
    compareVersions(preferred, daemonApiVersion) <= 0
      ? preferred
      : daemonApiVersion;
  if (compareVersions(ceiling, daemonMinApiVersion) < 0) {
    throw new DockerUnavailableError(
      `Docker daemon requires API ${daemonMinApiVersion} or newer, but this adapter ` +
        `supports at most ${preferred}`,
    );
  }
  return ceiling;
}
/** Splits Docker's multiplexed log stream into stdout and stderr. */
export function demultiplexLogStream(stream, maxBytesPerStream) {
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let offset = 0;
  while (offset + LOG_FRAME_HEADER_BYTES <= stream.length) {
    const streamType = stream[offset];
    const frameLength = stream.readUInt32BE(offset + 4);
    const payloadStart = offset + LOG_FRAME_HEADER_BYTES;
    const payloadEnd = Math.min(payloadStart + frameLength, stream.length);
    if (frameLength === 0) {
      offset = payloadEnd;
      continue;
    }
    const payload = stream.subarray(payloadStart, payloadEnd);
    if (streamType === LOG_STREAM_STDERR) {
      const remaining = maxBytesPerStream - stderrBytes;
      if (remaining > 0) {
        stderr.push(payload.subarray(0, remaining));
        stderrBytes += Math.min(payload.length, remaining);
      }
      if (payload.length > remaining) stderrTruncated = true;
    } else if (streamType === LOG_STREAM_STDOUT) {
      const remaining = maxBytesPerStream - stdoutBytes;
      if (remaining > 0) {
        stdout.push(payload.subarray(0, remaining));
        stdoutBytes += Math.min(payload.length, remaining);
      }
      if (payload.length > remaining) stdoutTruncated = true;
    }
    offset = payloadEnd;
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdoutTruncated,
    stderrTruncated,
  };
}
export class DockerEngineClient {
  socketPath;
  apiVersion = null;
  constructor(socketPath) {
    this.socketPath = socketPath;
  }
  send(method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const payload =
        body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const headers = { Host: "localhost" };
      if (payload) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(payload.length);
      }
      const request = http.request(
        { socketPath: this.socketPath, method, path, headers },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks),
            }),
          );
          response.on("error", reject);
        },
      );
      request.setTimeout(timeoutMs, () => {
        request.destroy(
          new DockerTimeoutError(`Docker request ${method} ${path} timed out`),
        );
      });
      request.on("error", (error) => {
        if (error instanceof DockerTimeoutError) {
          reject(error);
          return;
        }
        if (
          error.code === "ENOENT" ||
          error.code === "ECONNREFUSED" ||
          error.code === "EACCES"
        ) {
          reject(
            new DockerUnavailableError(
              `Docker daemon is not reachable at ${this.socketPath} (${error.code})`,
            ),
          );
          return;
        }
        reject(error);
      });
      if (payload) request.write(payload);
      request.end();
    });
  }
  static decode(response, method, path) {
    const text = response.body.toString("utf8");
    if (response.statusCode < 200 || response.statusCode >= 300) {
      let message = text.trim();
      try {
        const parsed = JSON.parse(text);
        if (parsed.message) message = parsed.message;
      } catch {
        // Non-JSON error bodies are surfaced verbatim.
      }
      throw new DockerApiError(
        `Docker ${method} ${path} failed with ${response.statusCode}: ${message}`,
        response.statusCode,
      );
    }
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  async call(method, path, body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const response = await this.send(method, path, body, timeoutMs);
    return DockerEngineClient.decode(response, method, path);
  }
  async version() {
    const payload = await this.call("GET", "/version");
    if (!payload?.ApiVersion) {
      throw new DockerUnavailableError(
        "Docker daemon did not report an API version",
      );
    }
    return {
      serverVersion: payload.Version ?? "unknown",
      apiVersion: payload.ApiVersion,
      minApiVersion: payload.MinAPIVersion ?? payload.ApiVersion,
    };
  }
  /** Resolves and caches the API version prefix used by every other call. */
  async prefix() {
    if (!this.apiVersion) {
      const version = await this.version();
      this.apiVersion = negotiateApiVersion(
        version.apiVersion,
        version.minApiVersion,
      );
    }
    return `/v${this.apiVersion}`;
  }
  async imageExists(reference) {
    const base = await this.prefix();
    try {
      await this.call(
        "GET",
        `${base}/images/${encodeURIComponent(reference)}/json`,
      );
      return true;
    } catch (error) {
      if (error instanceof DockerApiError && error.statusCode === 404)
        return false;
      throw error;
    }
  }
  async createContainer(name, spec) {
    const base = await this.prefix();
    const created = await this.call(
      "POST",
      `${base}/containers/create?name=${encodeURIComponent(name)}`,
      spec,
    );
    if (!created?.Id) {
      throw new DockerApiError("Docker did not return a container id", 500);
    }
    return created.Id;
  }
  async startContainer(containerId) {
    const base = await this.prefix();
    await this.call("POST", `${base}/containers/${containerId}/start`);
  }
  /** Long-polls until the container is no longer running. */
  async waitContainer(containerId, timeoutMs) {
    const base = await this.prefix();
    const result = await this.call(
      "POST",
      `${base}/containers/${containerId}/wait?condition=not-running`,
      undefined,
      timeoutMs,
    );
    return result?.StatusCode ?? -1;
  }
  async inspectContainer(containerId) {
    const base = await this.prefix();
    const payload = await this.call(
      "GET",
      `${base}/containers/${containerId}/json`,
    );
    const state = payload?.State ?? {};
    return {
      status: state.Status ?? "unknown",
      exitCode: state.Running ? null : (state.ExitCode ?? null),
      oomKilled: state.OOMKilled === true,
      error: state.Error ?? "",
      startedAt: state.StartedAt ?? null,
      finishedAt: state.FinishedAt ?? null,
    };
  }
  async stopContainer(containerId, timeoutSeconds) {
    const base = await this.prefix();
    try {
      await this.call(
        "POST",
        `${base}/containers/${containerId}/stop?t=${timeoutSeconds}`,
        undefined,
        (timeoutSeconds + 10) * 1_000,
      );
    } catch (error) {
      // 304 means it had already stopped, 404 that it is already gone.
      if (
        error instanceof DockerApiError &&
        (error.statusCode === 304 || error.statusCode === 404)
      ) {
        return;
      }
      throw error;
    }
  }
  async readLogs(containerId, maxBytesPerStream) {
    const base = await this.prefix();
    const response = await this.send(
      "GET",
      `${base}/containers/${containerId}/logs?stdout=1&stderr=1&tail=all`,
      undefined,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new DockerApiError(
        `Docker log read failed with ${response.statusCode}`,
        response.statusCode,
      );
    }
    return demultiplexLogStream(response.body, maxBytesPerStream);
  }
  async removeContainer(containerId) {
    const base = await this.prefix();
    try {
      await this.call(
        "DELETE",
        `${base}/containers/${containerId}?force=1&v=1`,
      );
    } catch (error) {
      if (error instanceof DockerApiError && error.statusCode === 404) return;
      throw error;
    }
  }
}
