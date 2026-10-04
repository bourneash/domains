'use strict';
function conflictPort(stderr, ports) {
  if (!/address already in use/i.test(stderr || '')) return null;
  const match = String(stderr).match(
    /failed to bind host port (?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)\/tcp/i
  );
  const port = Number(match?.[1]);
  return [ports.ttyd, ports.dev].includes(port) ? port : null;
}
async function runWithPortRetry({
  args,
  name,
  ports,
  run,
  allocate,
  reserved = new Set(),
  maxAttempts = 3,
}) {
  let currentArgs = [...args],
    currentPorts = { ...ports },
    result;
  const conflicts = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    result = await run(currentArgs);
    if (result.code === 0) return { result, ports: currentPorts, port_conflicts: conflicts };
    const port = conflictPort(result.stderr, currentPorts);
    if (!port) return { result, ports: currentPorts, port_conflicts: conflicts };
    conflicts.push(port);
    reserved.add(port);
    // A failed create may leave an object behind. Non-forced removal never stops a live container.
    const removed = await run(['rm', name]);
    if (removed.code !== 0 && !/No such container/i.test(removed.stderr || ''))
      return {
        result: {
          code: removed.code,
          stderr: 'Failed to remove stopped sandbox after port conflict: ' + removed.stderr,
        },
        ports: currentPorts,
        port_conflicts: conflicts,
      };
    if (attempt + 1 >= maxAttempts) break;
    const previous = currentPorts;
    currentPorts = await allocate(reserved);
    currentArgs = currentArgs.map((value, index) =>
      currentArgs[index - 1] === '-p'
        ? value === `127.0.0.1:${previous.ttyd}:7681`
          ? `127.0.0.1:${currentPorts.ttyd}:7681`
          : value.startsWith(`127.0.0.1:${previous.dev}:`)
            ? value.replace(`127.0.0.1:${previous.dev}:`, `127.0.0.1:${currentPorts.dev}:`)
            : value
        : value
    );
  }
  return { result, ports: currentPorts, port_conflicts: conflicts };
}
module.exports = { conflictPort, runWithPortRetry };
