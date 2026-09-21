FROM domain-developer:latest

# The model image contains the runner code, but runtime receives no repository
# mount. It only sees /input/brief.json and can write /output/plan.json.
COPY --chown=dev:dev tools/executive /app/tools/executive
COPY --chown=dev:dev tools/fleet-dashboard/server/eventstore.js /app/tools/fleet-dashboard/server/eventstore.js
COPY --chown=dev:dev tools/fleet-dashboard/server/executive.js /app/tools/fleet-dashboard/server/executive.js
COPY --chown=dev:dev tools/fleet-dashboard/server/changequeue.js /app/tools/fleet-dashboard/server/changequeue.js
COPY --chown=dev:dev tools/fleet-dashboard/server/executive-snapshot.js /app/tools/fleet-dashboard/server/executive-snapshot.js
USER root
RUN mkdir -p /input /output && chown -R dev:dev /input /output
USER dev
WORKDIR /app
