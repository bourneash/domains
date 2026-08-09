//! Multi-street solve cost: turn solves at full width, flop solves under
//! runout abstraction, and what a full flop solve would actually cost.

use poker_engine::equity::parse_range;
use poker_engine::eval::parse_cards;
use poker_engine::street::{BetConfig, Game};
use std::time::Instant;

/// A plausible single-raised-pot range rather than all 1326 combos — solving
/// every hand against every hand is not what a real spot looks like.
const RANGE: &str = "AA,KK,QQ,JJ,TT,99,88,77,66,55,\
AKs,AQs,AJs,ATs,A9s,A5s,A4s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,87s,76s,\
AKo,AQo,AJo,KQo,KJo,QJo";

fn human(b: usize) -> String {
    if b >= 1 << 30 {
        format!("{:.2} GB", b as f64 / (1u64 << 30) as f64)
    } else if b >= 1 << 20 {
        format!("{:.1} MB", b as f64 / (1u64 << 20) as f64)
    } else {
        format!("{:.1} KB", b as f64 / 1024.0)
    }
}

fn cfg(buckets: Option<usize>, raise: bool) -> BetConfig {
    BetConfig {
        pot: 20.0,
        bet_frac: 0.7,
        allow_raise: raise,
        runout_buckets: buckets,
    }
}

fn report(label: &str, board: &str, cfg: BetConfig, iters: u32) -> f64 {
    let b = parse_cards(board);
    let r = parse_range(RANGE);
    let t0 = Instant::now();
    let mut g = Game::build(&b, r.clone(), r, cfg);
    let build = t0.elapsed().as_secs_f64();

    println!("\n{label}  (board {board}, {} combos/side)", g.combos[0].len());
    println!(
        "  nodes {:>9} | decisions {:>8} | showdown boards {:>7}",
        g.n_nodes(),
        g.n_decision_nodes(),
        g.n_showdowns()
    );
    println!(
        "  solved-output {:>10} | solver working set {:>10} | build {:.2}s",
        human(g.strategy_slots()),
        human(g.solver_bytes()),
        build
    );

    // Convergence curve, not a single point: one number cannot distinguish
    // "needs more iterations" from "not converging".
    let mut total = 0.0;
    let mut done = 0u32;
    for step in [iters / 8, iters / 4, iters / 2, iters - iters / 8 - iters / 4 - iters / 2] {
        if step == 0 {
            continue;
        }
        let t0 = Instant::now();
        g.run(step);
        total += t0.elapsed().as_secs_f64();
        done += step;
        let expl = g.exploitability();
        println!(
            "    {done:>6} iters | {:>6.1}ms/iter | exploitability {expl:>8.4} chips ({:>6.2}% of pot)",
            total / done as f64 * 1000.0,
            expl / 20.0 * 100.0
        );
    }
    total / done as f64
}

fn main() {
    println!("=== multi-street solve cost ===");

    // Turn solves: every river card enumerated, no abstraction at all.
    report("[turn] full width, no raise", "2c7d9hJs", cfg(None, false), 2000);
    report("[turn] full width, with raise", "2c7d9hJs", cfg(None, true), 2000);

    // Flop solves under runout abstraction, to measure how cost scales.
    let mut points = Vec::new();
    for b in [3usize, 4, 6, 8] {
        let per_iter = report(
            &format!("[flop] {b} turn buckets x {b} river buckets"),
            "2c7d9h",
            cfg(Some(b), false),
            400,
        );
        points.push((b, per_iter));
    }

    // Extrapolate to a real flop: 49 turns x 48 rivers.
    println!("\n=== extrapolation to a full flop solve (49 turns x 48 rivers) ===");
    println!("  {:>8} {:>14} {:>18}", "buckets", "ms/iter", "implied full solve");
    for (b, per_iter) in &points {
        let scale = (49.0 * 48.0) / (*b as f64 * *b as f64);
        let full_iter = per_iter * scale;
        println!(
            "  {:>8} {:>14.1} {:>15.1} s/iter",
            format!("{b}x{b}"),
            per_iter * 1000.0,
            full_iter
        );
    }
    if let Some((b, per_iter)) = points.last() {
        let scale = (49.0 * 48.0) / (*b as f64 * *b as f64);
        let full_iter = per_iter * scale;
        let iters = 400.0;
        let per_spot = full_iter * iters;
        // 1755 strategically distinct flops once suit isomorphism is applied.
        const FLOPS: f64 = 1755.0;

        println!("\n  Exact flop solve, {iters:.0} iterations (~0.15% of pot exploitable):");
        println!("    {:.1} min/spot on one core", per_spot / 60.0);
        println!(
            "    all {FLOPS:.0} distinct flops: {:.0} core-hours ({:.1} days on 8 cores)",
            per_spot * FLOPS / 3600.0,
            per_spot * FLOPS / 3600.0 / 8.0 / 24.0
        );
        // Solved-output storage scales with the tree the same way time does.
        let bytes_full = 887.4 * 1024.0 * scale;
        println!(
            "    storage: {:.0} MB/spot, {:.0} GB for the full library",
            bytes_full / 1024.0 / 1024.0,
            bytes_full * FLOPS / 1024.0 / 1024.0 / 1024.0
        );

        println!("\n  Same library at {b}x{b} runout abstraction:");
        println!("    {:.0} s/spot, {:.1} core-hours for all {FLOPS:.0} flops", per_iter * iters, per_iter * iters * FLOPS / 3600.0);
        println!(
            "    storage: {:.1} MB/spot, {:.1} GB for the full library",
            887.4 / 1024.0,
            887.4 * 1024.0 * FLOPS / 1024.0 / 1024.0 / 1024.0
        );
    }
}
