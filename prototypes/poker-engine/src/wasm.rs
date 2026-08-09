//! The ABI the browser app talks to.
//!
//! Deliberately raw `extern "C"` with a linear-memory buffer instead of
//! wasm-bindgen: it keeps the module at ~70 KB with no JS glue to version.
//! Cards are single bytes (`rank * 4 + suit`), so every array crossing the
//! boundary is just `Uint8Array`.

use crate::equity::{mc_range_vs_range, Equity};
use crate::eval::eval7;

/// Hand over a buffer for JS to write into. Pair with `ps_free`.
#[no_mangle]
pub extern "C" fn ps_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from a previous `ps_alloc` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn ps_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, len, len));
}

unsafe fn combos(ptr: *const u8, n: usize) -> Vec<[u8; 2]> {
    let s = std::slice::from_raw_parts(ptr, n * 2);
    (0..n).map(|i| [s[i * 2], s[i * 2 + 1]]).collect()
}

/// Equity of one hand against a range on a given board, as a fraction.
/// Ties count as half, matching how every equity calculator reports it.
///
/// # Safety
/// Pointers must be valid for the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn ps_equity(
    hero_ptr: *const u8,
    board_ptr: *const u8,
    board_len: usize,
    range_ptr: *const u8,
    range_n: usize,
    iters: u32,
    seed: u32,
) -> f64 {
    let h = std::slice::from_raw_parts(hero_ptr, 2);
    let hero = [[h[0], h[1]]];
    let board = std::slice::from_raw_parts(board_ptr, board_len).to_vec();
    let vill = combos(range_ptr, range_n);
    if vill.is_empty() {
        return f64::NAN;
    }
    mc_range_vs_range(&hero, &vill, &board, iters, seed as u64 | 1).pct()
}

/// Equity of a whole range against another range — used for board-texture
/// drills where the question is about ranges, not one hand.
///
/// # Safety
/// Pointers must be valid for the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn ps_range_equity(
    hero_ptr: *const u8,
    hero_n: usize,
    board_ptr: *const u8,
    board_len: usize,
    range_ptr: *const u8,
    range_n: usize,
    iters: u32,
    seed: u32,
) -> f64 {
    let hero = combos(hero_ptr, hero_n);
    let board = std::slice::from_raw_parts(board_ptr, board_len).to_vec();
    let vill = combos(range_ptr, range_n);
    if hero.is_empty() || vill.is_empty() {
        return f64::NAN;
    }
    mc_range_vs_range(&hero, &vill, &board, iters, seed as u64 | 1).pct()
}

/// Comparable strength score for 5, 6 or 7 cards. Only ever compared.
///
/// # Safety
/// `ptr` must be valid for `len` bytes, with `5 <= len <= 7`.
#[no_mangle]
pub unsafe extern "C" fn ps_eval(ptr: *const u8, len: usize) -> u32 {
    eval7(std::slice::from_raw_parts(ptr, len))
}

/// Hand category alone (0 = high card … 8 = straight flush), for labelling.
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn ps_category(ptr: *const u8, len: usize) -> u32 {
    eval7(std::slice::from_raw_parts(ptr, len)) >> 20
}

/// Win / tie / total in one call, written back as three f64s so a drill can
/// show "you win X%, chop Y%" without three round trips.
///
/// # Safety
/// Pointers must be valid; `out` must have room for 3 f64 values.
#[no_mangle]
pub unsafe extern "C" fn ps_equity_detail(
    hero_ptr: *const u8,
    board_ptr: *const u8,
    board_len: usize,
    range_ptr: *const u8,
    range_n: usize,
    iters: u32,
    seed: u32,
    out: *mut f64,
) {
    let h = std::slice::from_raw_parts(hero_ptr, 2);
    let hero = [[h[0], h[1]]];
    let board = std::slice::from_raw_parts(board_ptr, board_len).to_vec();
    let vill = combos(range_ptr, range_n);
    let e: Equity = if vill.is_empty() {
        Equity::default()
    } else {
        mc_range_vs_range(&hero, &vill, &board, iters, seed as u64 | 1)
    };
    let t = e.total.max(1) as f64;
    *out = e.wins as f64 / t;
    *out.add(1) = e.ties as f64 / t;
    *out.add(2) = e.pct();
}
