use poker_engine::equity::{enum_hand_vs_hand, parse_range};
use poker_engine::eval::parse_cards;
use poker_engine::tree::{count_tree, TreeConfig};
use poker_engine::{
    bench_equity_inner, bench_eval7_inner, bench_range_equity_inner, river,
};
use std::time::Instant;

fn secs(f: impl FnOnce()) -> f64 {
    let t = Instant::now();
    f();
    t.elapsed().as_secs_f64()
}

fn hand(s: &str) -> [u8; 2] {
    let c = parse_cards(s);
    [c[0], c[1]]
}

fn main() {
    println!("=== poker-engine prototype: native benchmarks ===\n");

    // 1. Evaluator throughput
    let n = 20_000_000u32;
    let t = secs(|| {
        std::hint::black_box(bench_eval7_inner(n));
    });
    println!("[eval] 7-card evaluations");
    println!("  {n} evals in {t:.3}s  =>  {:.1}M evals/sec", n as f64 / t / 1e6);

    // 2. Monte Carlo equity, hand vs hand
    let n = 1_000_000u32;
    let t = secs(|| {
        std::hint::black_box(bench_equity_inner(n));
    });
    println!("\n[equity] AKs vs QQ preflop, Monte Carlo");
    println!("  {n} trials in {t:.3}s  =>  {:.1}M trials/sec", n as f64 / t / 1e6);
    println!("  10k-trial latency (a UI-blocking unit): {:.2}ms", t / n as f64 * 10_000.0 * 1000.0);

    // 3. Exact enumeration for ground truth
    let t = secs(|| {
        let e = enum_hand_vs_hand(hand("AsKs"), hand("QhQd"), &[]);
        println!("\n[equity] same spot, exhaustive over all 1,712,304 boards");
        println!("  exact equity = {:.4}", e.pct());
    });
    println!("  full enumeration in {t:.3}s");
    println!("  MC 100k estimate = {:.4}", bench_equity_inner(100_000) as f64 / 1e6);

    // 4. Range vs range on a flop
    let n = 1_000_000u32;
    let t = secs(|| {
        std::hint::black_box(bench_range_equity_inner(n));
    });
    println!("\n[equity] 10-hand range vs 20-hand range on 7h2d9c");
    println!("  {n} trials in {t:.3}s  =>  {:.1}M trials/sec", n as f64 / t / 1e6);
    println!("  equity = {:.4}", bench_range_equity_inner(200_000) as f64 / 1e6);

    // 5. Preflop tree sizing — the "does it fit in the payload" question
    println!("\n[tree] 6-max preflop strategy table size");
    println!("  {:<28} {:>12} {:>14} {:>12}", "config", "decisions", "action slots", "u8 table");
    for (label, cfg) in [
        ("2 sizes, cap 2", TreeConfig { players: 6, raise_sizes: 2, raise_cap: 2 }),
        ("2 sizes, cap 3", TreeConfig { players: 6, raise_sizes: 2, raise_cap: 3 }),
        ("3 sizes, cap 3", TreeConfig { players: 6, raise_sizes: 3, raise_cap: 3 }),
        ("3 sizes, cap 4", TreeConfig { players: 6, raise_sizes: 3, raise_cap: 4 }),
        ("4 sizes, cap 4", TreeConfig { players: 6, raise_sizes: 4, raise_cap: 4 }),
        ("heads-up, 3 sizes, cap 4", TreeConfig { players: 2, raise_sizes: 3, raise_cap: 4 }),
    ] {
        let st = count_tree(cfg);
        let bytes = st.strategy_bytes();
        println!(
            "  {label:<28} {:>12} {:>14} {:>12}",
            st.decision_nodes,
            st.action_slots,
            human(bytes)
        );
    }

    // 6. River CFR — the postflop precompute feasibility test
    println!("\n[cfr] river subgame solve (exact, no abstraction)");
    let board = parse_cards("2c7d9hJsKd");
    let oop = parse_range("AA,KK,QQ,JJ,TT,99,88,77,AKs,AQs,AJs,ATs,KQs,KJs,QJs,JTs,AKo,AQo,KQo");
    let ip = parse_range("AA,KK,QQ,JJ,TT,99,88,66,AKs,AQs,ATs,KTs,QTs,T9s,98s,AKo,AJo,KQo");
    let mut s = river::Solver::new_river(&board, oop, ip, 20.0, 14.0, 45.0);
    println!(
        "  ranges: {} vs {} combos, {} decision nodes",
        s.n_combos(0),
        s.n_combos(1),
        s.n_decision_nodes()
    );
    println!("  pot = 20 chips; exploitability in chips/hand and as % of pot");
    for iters in [50u32, 200, 750, 3000, 6000] {
        let t = secs(|| s.run(iters));
        let expl = s.exploitability();
        println!(
            "  {:>5} iters | {:>7.3}s batch | {:>8.0} it/s | exploitability {:>9.5} ({:>6.3}% of pot)",
            s.iterations,
            t,
            iters as f64 / t,
            expl,
            expl / 20.0 * 100.0
        );
    }

    // 7. Same solve at full range width — the realistic per-spot cost
    println!("\n[cfr] river solve at full range width");
    let wide: Vec<[u8; 2]> = poker_engine::equity::all_combos();
    let mut s = river::Solver::new_river(&board, wide.clone(), wide, 20.0, 14.0, 45.0);
    println!(
        "  ranges: {} vs {} combos, {} decision nodes",
        s.n_combos(0),
        s.n_combos(1),
        s.n_decision_nodes()
    );
    let t = secs(|| s.run(500));
    println!("  500 iters in {t:.3}s  =>  {:.0} iters/sec", 500.0 / t);
    let expl = s.exploitability();
    println!("  exploitability {expl:.5} chips ({:.3}% of pot)", expl / 20.0 * 100.0);
    // What a solved spot costs to store, which is what a spot library ships as.
    let slots: usize = (0..s.nodes.len())
        .filter_map(|i| match s.nodes[i] {
            river::Node::Decision { player, n_actions, .. } => {
                Some(n_actions * s.n_combos(player))
            }
            _ => None,
        })
        .sum();
    println!(
        "  solved-spot storage: {} strategy slots => {:.1} KB at 1 byte/slot",
        slots,
        slots as f64 / 1024.0
    );

    let per_solve = t / 500.0 * 1000.0;
    println!("  => ~{per_solve:.2}s for a 1000-iteration solve of one river spot");
    println!(
        "  => one core solves ~{:.0} spots/hour; 8 cores ~{:.0}/hour",
        3600.0 / per_solve,
        3600.0 / per_solve * 8.0
    );
}

fn human(b: u64) -> String {
    if b >= 1 << 30 {
        format!("{:.2} GB", b as f64 / (1u64 << 30) as f64)
    } else if b >= 1 << 20 {
        format!("{:.2} MB", b as f64 / (1u64 << 20) as f64)
    } else {
        format!("{:.1} KB", b as f64 / 1024.0)
    }
}
