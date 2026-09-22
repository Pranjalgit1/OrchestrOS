# The only image OrchestrOS ever runs as a workload. It carries a single fixed
# program, no shell entrypoint, no package dependencies, and no build step.
FROM node:24.13.0-alpine

# run.js is read-only and owned by root so the unprivileged runtime user cannot
# modify the program it executes.
COPY --chown=root:root run.js /opt/orchestros/run.js
RUN chmod 0444 /opt/orchestros/run.js

# The image ships with no writable working directory; the container also runs
# with a read-only root filesystem.
WORKDIR /opt/orchestros

# node:alpine already provides an unprivileged `node` user (uid 1000).
USER node

# Exec form, so no shell is involved and no argument can be injected.
ENTRYPOINT ["node", "/opt/orchestros/run.js"]
