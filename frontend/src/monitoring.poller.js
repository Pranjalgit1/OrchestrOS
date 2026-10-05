/** Poll each metric independently; slow history must never block live state. */
export function createMonitoringPoller({ sources, onData, onError,
  timeoutMs = 10_000, schedule = setTimeout, unschedule = clearTimeout }) {
  let stopped = false;
  const errors = new Map();
  const channels = Object.fromEntries(Object.entries(sources).map(([key, source]) =>
    [key, { ...source, controller: null, timer: null, deadline: null }]));

  async function read(key) {
    const channel = channels[key];
    if (stopped || channel.controller) return;
    unschedule(channel.timer);
    const controller = new AbortController();
    channel.controller = controller;
    // Race the request as well as aborting it, so a hung request can be retried.
    const deadline = new Promise((_, reject) => {
      channel.deadline = schedule(() => {
        reject(new Error("Request timed out"));
        controller.abort();
      }, timeoutMs);
    });
    try {
      const data = await Promise.race([channel.fetch(controller.signal), deadline]);
      if (stopped || controller.signal.aborted) return;
      onData(key, data);
      errors.delete(key);
    } catch (reason) {
      if (stopped) return;
      errors.set(key, `${channel.label}: ${reason instanceof Error ? reason.message : "Request failed"}`);
    } finally {
      unschedule(channel.deadline);
      channel.controller = null;
      if (!stopped) {
        onError([...errors.values()].join("; ") || null);
        channel.timer = schedule(() => void read(key), channel.intervalMs);
      }
    }
  }

  const poller = {
    refresh(keys = Object.keys(channels)) {
      for (const key of keys) void read(key);
    },
    stop() {
      stopped = true;
      for (const channel of Object.values(channels)) {
        unschedule(channel.timer);
        unschedule(channel.deadline);
        channel.controller?.abort();
      }
    },
  };
  poller.refresh();
  return poller;
}
