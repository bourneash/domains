FROM domain-developer:latest

# The model image contains the runner code, but runtime receives no repository
# mount. It only sees /input/brief.json and can write /output/plan.json.
COPY --chown=dev:dev tools/executive /app/tools/executive
COPY --chown=dev:dev tools/fleet-dashboard/server/eventstore.js /app/tools/fleet-dashboard/server/eventstore.js
COPY --chown=dev:dev tools/fleet-dashboard/server/executive.js /app/tools/fleet-dashboard/server/executive.js
COPY --chown=dev:dev tools/fleet-dashboard/server/changequeue.js /app/tools/fleet-dashboard/server/changequeue.js
COPY --chown=dev:dev tools/fleet-dashboard/server/task-routing.js /app/tools/fleet-dashboard/server/task-routing.js
COPY --chown=dev:dev tools/fleet-dashboard/server/executive-scorecard.js /app/tools/fleet-dashboard/server/executive-scorecard.js
COPY --chown=dev:dev tools/fleet-dashboard/server/executive-snapshot.js /app/tools/fleet-dashboard/server/executive-snapshot.js
COPY --chown=dev:dev tools/fleet-dashboard/server/executive-data.js /app/tools/fleet-dashboard/server/executive-data.js
COPY --chown=dev:dev tools/fleet-dashboard/server/workflow-engine.js /app/tools/fleet-dashboard/server/workflow-engine.js
COPY --chown=dev:dev tools/fleet-dashboard/server/roles.js /app/tools/fleet-dashboard/server/roles.js
COPY --chown=dev:dev tools/fleet-dashboard/server/sites.js /app/tools/fleet-dashboard/server/sites.js
COPY --chown=dev:dev tools/fleet-dashboard/server/git.js /app/tools/fleet-dashboard/server/git.js
COPY --chown=dev:dev tools/fleet-dashboard/server/deployhealth.js /app/tools/fleet-dashboard/server/deployhealth.js
COPY --chown=dev:dev tools/fleet-dashboard/server/execution.js /app/tools/fleet-dashboard/server/execution.js
COPY --chown=dev:dev tools/fleet-dashboard/server/cron/parse.js /app/tools/fleet-dashboard/server/cron/parse.js
COPY --chown=dev:dev tools/fleet-dashboard/server/cron/runinfo.js /app/tools/fleet-dashboard/server/cron/runinfo.js
USER root
RUN mkdir -p /input /output && chown -R dev:dev /input /output
USER dev
WORKDIR /app
