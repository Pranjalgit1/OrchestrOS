/**
 * Experiments that need the whole cluster to themselves: a policy benchmark
 * and an autoscaling comparison. Each registers how to tell whether it is
 * running, so either can refuse to start while the other runs, and the route
 * guard can refuse pipeline changes during both, without the two services
 * importing each other.
 */
const experiments = new Map();

/** `name` reads inside a sentence, for example "a policy benchmark". */
export function registerExperiment(name, isRunning) {
  experiments.set(name, isRunning);
}

/** The name of a running experiment other than `except`, or null. */
export function runningExperiment(except = null) {
  for (const [name, isRunning] of experiments) {
    if (name !== except && isRunning()) return name;
  }
  return null;
}

/** "a policy benchmark" becomes "A policy benchmark". */
export function sentenceStart(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
