# Executive runner isolation

Run the CEO/CTO with `tools/executive/run-sandbox.sh`. The model runner is not a
host service and should not be launched with `node tools/executive/runner.js`
in production.

The container policy is:

- two temporary bind mounts only: a generated brief at `/input` (read-only)
  and a plan output directory at `/output`;
- no Docker socket, SSH directory, host home directory, credential vault,
  sibling site directory, or host configuration mount;
- no added Linux capabilities, no privilege escalation, read-only root
  filesystem, bounded CPU/memory/processes, and a disposable `/tmp`;
- Claude runs in plan mode with permission prompts disabled and only the
  read-only `Read`, `Glob`, and `Grep` tools enabled; it cannot edit, execute
  shell commands, deploy, or push;
- network access is limited to the provider API; set
  `EXECUTIVE_NETWORK=none` for offline/dry-run operation;
- the only optional host material is a provider credential file and its
  matching single-file CLI config, both read-only; no host directory is
  mounted.

The runner can write only project data such as the event database and approved
queue records. It cannot call Docker, deploy Workers, push Git, read SSH keys,
or access another project. Production deployment remains behind the existing
change-queue/review/approval pipeline.
