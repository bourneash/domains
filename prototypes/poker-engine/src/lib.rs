pub mod equity;
pub mod eval;
pub mod river;
pub mod rng;
pub mod street;
pub mod tree;

use eval::{eval7, parse_cards};
use rng::Rng;

/// Fixed benchmark scenarios so the native and wasm runs are byte-identical
/// workloads. The host times the call; nothing here reads a clock.
pub fn bench_eval7_inner(iters: u32) -> u32 {
    let mut rng = Rng::new(0xDEAD_BEEF);
    let mut deck: [u8; 52] = [0; 52];
    for i in 0..52 {
        deck[i] = i as u8;
    }
    let mut acc: u32 = 0;
    let mut h = [0u8; 7];
    for _ in 0..iters {
        for i in 0..7 {
            let j = i + rng.below((52 - i) as u32) as usize;
            deck.swap(i, j);
            h[i] = deck[i];
        }
        acc = acc.wrapping_add(eval7(&h));
    }
    acc
}

pub fn bench_equity_inner(iters: u32) -> u32 {
    let hero = parse_cards("AsKs");
    let vill = parse_cards("QhQd");
    let e = equity::mc_hand_vs_hand([hero[0], hero[1]], [vill[0], vill[1]], &[], iters, 99);
    (e.pct() * 1_000_000.0) as u32
}

pub fn bench_range_equity_inner(iters: u32) -> u32 {
    let hero = equity::parse_range("AA,KK,QQ,JJ,TT,AKs,AQs,AJs,KQs,AKo");
    let vill = equity::parse_range(
        "99,88,77,66,55,44,33,22,ATs,A9s,KJs,KTs,QJs,QTs,JTs,T9s,98s,ATo,KJo,QJo",
    );
    let board = parse_cards("7h2d9c");
    let e = equity::mc_range_vs_range(&hero, &vill, &board, iters, 7);
    (e.pct() * 1_000_000.0) as u32
}

pub fn bench_river_cfr_inner(iters: u32) -> u32 {
    let board = parse_cards("2c7d9hJsKd");
    let oop = equity::parse_range("AA,KK,QQ,JJ,TT,99,88,77,AKs,AQs,AJs,ATs,KQs,KJs,QJs,JTs,AKo,AQo,KQo");
    let ip = equity::parse_range("AA,KK,QQ,JJ,TT,99,88,66,AKs,AQs,ATs,KTs,QTs,T9s,98s,AKo,AJo,KQo");
    let mut s = river::Solver::new_river(&board, oop, ip, 20.0, 14.0, 45.0);
    s.run(iters);
    (s.best_response(0).abs() * 1000.0) as u32
}

// --- wasm exports -----------------------------------------------------------
// Raw extern "C", no wasm-bindgen: these take and return scalars, so the JS
// harness needs no glue and the payload stays tiny.

#[no_mangle]
pub extern "C" fn bench_eval7(iters: u32) -> u32 {
    bench_eval7_inner(iters)
}

#[no_mangle]
pub extern "C" fn bench_equity(iters: u32) -> u32 {
    bench_equity_inner(iters)
}

#[no_mangle]
pub extern "C" fn bench_range_equity(iters: u32) -> u32 {
    bench_range_equity_inner(iters)
}

#[no_mangle]
pub extern "C" fn bench_river_cfr(iters: u32) -> u32 {
    bench_river_cfr_inner(iters)
}
