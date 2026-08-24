# fleet-dashboard — open security item

## fleet-dashboard runs as **root** with the whole monorepo mounted read-write

Found 2026-08-23 while hardening the site-tier containers.

```
container: fleet-dashboard
uid:       0            <-- root
mounts:    /home/jesse/projects/domains -> same path, READ-WRITE
           /var/run/docker.sock         -> READ-WRITE
cap_drop:  none
no-new-privileges: NO
```

This is the highest-risk container on the host, and it trips a rule the fleet
already treats as critical:

> Fleet worker containers mounting a repo rw MUST run as uid-1000 `ops`, never
> root — root commits corrupt `.git/objects`.

That corruption has already happened to four sites and needed `sudo` to undo.
The dashboard does `git add` / `commit` / `push` against the monorepo
(`server/git.js`, `server/run.js`, `server/roles.js`), so it is writing into
`.git` as root every time someone uses the Git tab.

Docker-socket access is *justified* here — the dashboard's job is managing
containers. Running as **root** is not: nothing it does needs uid 0.

## Why this was filed rather than fixed on the spot

The fix is small but it is the **control plane**. If it breaks, the tool you
would use to diagnose and recover is the tool that is down. It also needs a
real verification pass (git identity, file ownership, socket group access),
which is a deliberate change, not a drive-by. The site tier was hardened first
because breaking a site cron is recoverable from the dashboard; breaking the
dashboard is not.

## The fix

The base is `node:22-alpine`, which already ships a `node` user at **uid 1000**
— the same uid as `jesse` on the host, and the files the dashboard writes are
already `node:node`. So this is mostly a `USER` line plus socket group access:

1. `tools/fleet-dashboard/Dockerfile` — add before the entrypoint:
   ```dockerfile
   USER node
   ```
2. `docker-compose.yml` — the socket is root:docker on the host, so uid 1000
   needs the group, exactly as the site cron containers do:
   ```yaml
   group_add:
     - "${DOCKER_GID}"          # getent group docker | cut -d: -f3
   security_opt:
     - no-new-privileges:true
   cap_drop:
     - ALL
   ```
   (`cap_drop: ALL` was verified safe for every other container in this fleet,
   including ones driving the docker socket — capabilities are not what grants
   socket access, group membership is.)
3. Chown anything root already created under the tool's own dirs:
   ```
   docker run --rm -v /home/jesse/projects/domains:/w alpine:3.21 \
     sh -c 'chown -R 1000:1000 /w/tools/fleet-dashboard'
   ```
   (No host sudo needed — `sudo -n` is unavailable on this box; a root
   container is the sanctioned path for ownership repair.)

## Verify after

- Dashboard loads, Containers tab lists containers (proves socket access)
- Git tab can stage + commit + push a trivial change (proves git identity)
- `docker exec fleet-dashboard id -u` → `1000`
- `find /home/jesse/projects/domains -not -user jesse -not -path '*/node_modules/*'`
  returns only bind-mount stubs (`.monorepo-tools`, `.env.shared`)

## Also open, lower severity

The rest of the service tier has no hardening at all — 0/10 have `cap_drop`,
9/10 lack `no-new-privileges`, and `datahub-api`, `datahub-collector` and
`product-feed-api` also run as root (though **without** rw repo mounts, so they
carry no `.git` corruption risk). Worth a follow-up sweep once the dashboard
change is proven.
