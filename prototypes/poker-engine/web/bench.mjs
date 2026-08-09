// Runs the identical fixed workloads in wasm so the numbers are directly
// comparable to `cargo run --release --bin bench`.
import { readFile } from 'node:fs/promises';

const path = new URL(
  '../target/wasm32-unknown-unknown/release/poker_engine.wasm',
  import.meta.url,
);
const bytes = await readFile(path);
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports;

console.log('=== poker-engine prototype: wasm benchmarks ===');
console.log(`  module size: ${(bytes.length / 1024).toFixed(1)} KB`);
console.log(`  exports: ${Object.keys(wasm).filter((k) => k.startsWith('bench')).join(', ')}\n`);

function time(label, fn, n, unit) {
  fn(Math.min(n, 50_000)); // warm up the JIT before measuring
  const t0 = performance.now();
  const result = fn(n);
  const ms = performance.now() - t0;
  console.log(
    `${label}\n  ${n.toLocaleString()} ${unit} in ${(ms / 1000).toFixed(3)}s  =>  ` +
      `${(n / (ms / 1000) / 1e6).toFixed(2)}M ${unit}/sec  (result ${result})`,
  );
  return ms / n;
}

const perEval = time('[eval] 7-card evaluations', wasm.bench_eval7, 20_000_000, 'evals');
const perTrial = time(
  '[equity] AKs vs QQ preflop, Monte Carlo',
  wasm.bench_equity,
  1_000_000,
  'trials',
);
console.log(`  10k-trial latency: ${(perTrial * 10_000).toFixed(2)}ms`);

time('[equity] range vs range on a flop', wasm.bench_range_equity, 1_000_000, 'trials');

console.log('\n[cfr] river subgame solve');
for (const iters of [1000, 4000]) {
  const t0 = performance.now();
  wasm.bench_river_cfr(iters);
  const ms = performance.now() - t0;
  console.log(
    `  ${iters} iterations in ${(ms / 1000).toFixed(3)}s  =>  ${(iters / (ms / 1000)).toFixed(0)} it/s`,
  );
}

void perEval;
