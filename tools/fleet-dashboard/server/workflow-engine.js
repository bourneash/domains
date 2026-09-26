'use strict';

const TERMINAL = new Set(['done', 'cancelled', 'verified', 'deployed', 'committed']);
const PRIORITY_WEIGHT = { urgent: 4, high: 3, medium: 2, normal: 2, low: 1 };

function key(type, id) { return `${type}:${id}`; }
function buildGraph(items = [], links = []) {
  const nodes = new Map(items.map(item => [key(item.source, item.id), item]));
  const prerequisites = new Map([...nodes.keys()].map(node => [node, new Set()]));
  const dependents = new Map([...nodes.keys()].map(node => [node, new Set()]));
  for (const link of links) {
    let prerequisite, dependent;
    if (link.relation === 'blocks') { prerequisite = key(link.from_type, link.from_id); dependent = key(link.to_type, link.to_id); }
    else if (link.relation === 'blocked_by') { prerequisite = key(link.to_type, link.to_id); dependent = key(link.from_type, link.from_id); }
    else continue;
    if (!nodes.has(prerequisite) || !nodes.has(dependent)) continue;
    prerequisites.get(dependent).add(prerequisite);
    dependents.get(prerequisite).add(dependent);
  }
  return { nodes, prerequisites, dependents };
}

function findCycles(graph) {
  const visiting = new Set(), visited = new Set(), cycles = [];
  function visit(node, path) {
    if (visiting.has(node)) { cycles.push([...path.slice(path.indexOf(node)), node]); return; }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of graph.dependents.get(node) || []) visit(next, [...path, node]);
    visiting.delete(node); visited.add(node);
  }
  for (const node of graph.nodes.keys()) visit(node, []);
  return cycles;
}

function evaluate({ items = [], links = [], now = new Date() } = {}) {
  const graph = buildGraph(items, links), cycles = findCycles(graph), nodes = {};
  const unresolved = node => [...(graph.prerequisites.get(node) || [])].filter(prereq => !TERMINAL.has(graph.nodes.get(prereq)?.status));
  const longest = (node, seen = new Set()) => {
    if (seen.has(node)) return 0;
    const nextSeen = new Set(seen).add(node);
    return 1 + Math.max(0, ...[...(graph.dependents.get(node) || [])].map(child => longest(child, nextSeen)));
  };
  for (const [node, item] of graph.nodes) {
    const blockers = unresolved(node);
    const priority = PRIORITY_WEIGHT[item.priority] || 1;
    nodes[node] = {
      key: node, source: item.source, id: item.id, title: item.title, status: item.status,
      blockers, ready: !blockers.length && !cycles.some(cycle => cycle.includes(node)),
      critical_score: priority + longest(node),
      critical: false,
    };
  }
  const maxScore = Math.max(0, ...Object.values(nodes).map(node => node.critical_score));
  Object.values(nodes).forEach(node => { node.critical = node.critical_score === maxScore && maxScore > 0; });
  const alerts = [];
  cycles.forEach(cycle => alerts.push({ kind: 'cycle', severity: 'high', title: 'Circular dependency', nodes: cycle, message: `Cycle detected: ${cycle.join(' → ')}` }));
  Object.values(nodes).forEach(node => {
    if (node.blockers.length && !TERMINAL.has(node.status)) alerts.push({ kind: 'blocked', severity: 'high', node: node.key, title: node.title, message: `${node.title} is blocked by ${node.blockers.join(', ')}` });
    const item = graph.nodes.get(node.key);
    if (item?.due_at && new Date(item.due_at) < now && !TERMINAL.has(item.status)) alerts.push({ kind: 'overdue', severity: 'high', node: node.key, title: item.title, message: `Due ${item.due_at}` });
  });
  return { nodes, cycles, alerts, critical_path: Object.values(nodes).filter(node => node.critical).map(node => node.key).sort() };
}

module.exports = { TERMINAL, buildGraph, findCycles, evaluate, key };
