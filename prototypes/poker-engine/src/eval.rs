//! 7-card hand evaluator.
//!
//! Card encoding: `card = rank * 4 + suit`, rank 0..=12 (2..A), suit 0..=3.
//!
//! Table-free on purpose. The classic fast evaluators (two-plus-two's 130MB
//! lookup) are non-starters for a wasm payload we ship to a browser, so this
//! computes from rank/suit histograms instead. The benchmark exists to prove
//! that's fast enough.
//!
//! Score layout: `category << 20 | k1 << 16 | k2 << 12 | k3 << 8 | k4 << 4 | k5`.
//! Higher is better; scores are only ever compared, never decoded.

pub const HIGH_CARD: u32 = 0;
pub const PAIR: u32 = 1;
pub const TWO_PAIR: u32 = 2;
pub const TRIPS: u32 = 3;
pub const STRAIGHT: u32 = 4;
pub const FLUSH: u32 = 5;
pub const FULL_HOUSE: u32 = 6;
pub const QUADS: u32 = 7;
pub const STRAIGHT_FLUSH: u32 = 8;

#[inline(always)]
fn mk(cat: u32, k: [u8; 5]) -> u32 {
    (cat << 20)
        | ((k[0] as u32) << 16)
        | ((k[1] as u32) << 12)
        | ((k[2] as u32) << 8)
        | ((k[3] as u32) << 4)
        | (k[4] as u32)
}

/// Highest card of a 5-straight in a 13-bit rank mask, or `None`.
/// Returns the rank index of the top card (so the wheel returns 3, i.e. "5").
#[inline(always)]
fn straight_high(rank_mask: u16) -> Option<u8> {
    // Shift up by one and stick ace-low in bit 0 so the wheel is a normal window.
    let mut m: u16 = rank_mask << 1;
    if rank_mask & (1 << 12) != 0 {
        m |= 1;
    }
    let mut hi: i32 = 13;
    while hi >= 4 {
        let window = 0b11111u16 << (hi - 4);
        if m & window == window {
            return Some((hi - 1) as u8);
        }
        hi -= 1;
    }
    None
}

/// Top `n` ranks in `mask`, skipping any rank in `excl`.
#[inline(always)]
fn top_n(mask: u16, excl: &[i32], n: usize, out: &mut [u8; 5], at: usize) {
    let mut got = 0;
    let mut r: i32 = 12;
    while r >= 0 && got < n {
        if mask & (1 << r) != 0 && !excl.contains(&r) {
            out[at + got] = r as u8;
            got += 1;
        }
        r -= 1;
    }
}

pub fn eval7(cards: &[u8]) -> u32 {
    let mut rank_cnt = [0u8; 13];
    let mut suit_cnt = [0u8; 4];
    let mut suit_mask = [0u16; 4];
    let mut rank_mask = 0u16;

    for &c in cards {
        let r = (c >> 2) as usize;
        let s = (c & 3) as usize;
        rank_cnt[r] += 1;
        suit_cnt[s] += 1;
        suit_mask[s] |= 1 << r;
        rank_mask |= 1 << r;
    }

    // With exactly 7 cards a flush rules out quads and full houses, so this
    // early return is safe: 5 flush cards have distinct ranks, leaving only 2
    // others — not enough for trips+pair or four of a kind.
    for s in 0..4 {
        if suit_cnt[s] >= 5 {
            let fm = suit_mask[s];
            if let Some(h) = straight_high(fm) {
                return mk(STRAIGHT_FLUSH, [h, 0, 0, 0, 0]);
            }
            let mut k = [0u8; 5];
            top_n(fm, &[], 5, &mut k, 0);
            return mk(FLUSH, k);
        }
    }

    let mut quads: i32 = -1;
    let mut trips: i32 = -1;
    let mut trips2: i32 = -1;
    let mut pairs: [i32; 3] = [-1; 3];
    let mut np = 0usize;

    for r in (0..13).rev() {
        match rank_cnt[r] {
            4 => {
                if quads < 0 {
                    quads = r as i32
                }
            }
            3 => {
                if trips < 0 {
                    trips = r as i32
                } else if trips2 < 0 {
                    trips2 = r as i32
                }
            }
            2 => {
                if np < 3 {
                    pairs[np] = r as i32;
                    np += 1;
                }
            }
            _ => {}
        }
    }

    if quads >= 0 {
        let mut k = [0u8; 5];
        k[0] = quads as u8;
        top_n(rank_mask, &[quads], 1, &mut k, 1);
        return mk(QUADS, k);
    }

    if trips >= 0 && (trips2 >= 0 || np > 0) {
        // Second trips can play as the pair; take whichever pairs highest.
        let pr = if trips2 > pairs[0] { trips2 } else { pairs[0] };
        return mk(FULL_HOUSE, [trips as u8, pr as u8, 0, 0, 0]);
    }

    if let Some(h) = straight_high(rank_mask) {
        return mk(STRAIGHT, [h, 0, 0, 0, 0]);
    }

    if trips >= 0 {
        let mut k = [0u8; 5];
        k[0] = trips as u8;
        top_n(rank_mask, &[trips], 2, &mut k, 1);
        return mk(TRIPS, k);
    }

    if np >= 2 {
        let mut k = [0u8; 5];
        k[0] = pairs[0] as u8;
        k[1] = pairs[1] as u8;
        top_n(rank_mask, &[pairs[0], pairs[1]], 1, &mut k, 2);
        return mk(TWO_PAIR, k);
    }

    if np == 1 {
        let mut k = [0u8; 5];
        k[0] = pairs[0] as u8;
        top_n(rank_mask, &[pairs[0]], 3, &mut k, 1);
        return mk(PAIR, k);
    }

    let mut k = [0u8; 5];
    top_n(rank_mask, &[], 5, &mut k, 0);
    mk(HIGH_CARD, k)
}

/// Parse "AsKh" style notation. Ranks `23456789TJQKA`, suits `cdhs`.
pub fn parse_cards(s: &str) -> Vec<u8> {
    const RANKS: &[u8] = b"23456789TJQKA";
    const SUITS: &[u8] = b"cdhs";
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len() / 2);
    let mut i = 0;
    while i + 1 < b.len() {
        let r = RANKS.iter().position(|&x| x == b[i]).expect("bad rank") as u8;
        let su = SUITS.iter().position(|&x| x == b[i + 1]).expect("bad suit") as u8;
        out.push(r * 4 + su);
        i += 2;
    }
    out
}

/// Deliberately naive reference evaluator: best of all 21 five-card subsets,
/// each scored by an implementation that shares no code with `eval7`. Slow, but
/// it is the ground truth the fast path gets fuzzed against.
#[cfg(test)]
pub fn eval7_reference(cards: &[u8]) -> Vec<u8> {
    fn eval5(c: &[u8; 5]) -> Vec<u8> {
        let mut ranks: Vec<u8> = c.iter().map(|x| x >> 2).collect();
        let suits: Vec<u8> = c.iter().map(|x| x & 3).collect();
        ranks.sort_unstable_by(|a, b| b.cmp(a));

        let flush = suits.iter().all(|&s| s == suits[0]);
        let mut uniq = ranks.clone();
        uniq.dedup();

        // straight: five distinct consecutive ranks, plus the A-5 wheel
        let mut straight_top: Option<u8> = None;
        if uniq.len() == 5 {
            if uniq[0] as i32 - uniq[4] as i32 == 4 {
                straight_top = Some(uniq[0]);
            } else if uniq == vec![12, 3, 2, 1, 0] {
                straight_top = Some(3);
            }
        }

        // group ranks by multiplicity, then by rank
        let mut groups: Vec<(usize, u8)> = Vec::new();
        for &r in &uniq {
            groups.push((ranks.iter().filter(|&&x| x == r).count(), r));
        }
        groups.sort_unstable_by(|a, b| b.cmp(a));
        let shape: Vec<usize> = groups.iter().map(|g| g.0).collect();
        let order: Vec<u8> = groups.iter().map(|g| g.1).collect();

        let cat: u8 = match (flush, straight_top, shape.as_slice()) {
            (true, Some(_), _) => 8,
            (_, _, [4, 1]) => 7,
            (_, _, [3, 2]) => 6,
            (true, _, _) => 5,
            (_, Some(_), _) => 4,
            (_, _, [3, 1, 1]) => 3,
            (_, _, [2, 2, 1]) => 2,
            (_, _, [2, 1, 1, 1]) => 1,
            _ => 0,
        };
        let mut out = vec![cat];
        if cat == 8 || cat == 4 {
            out.push(straight_top.unwrap());
        } else {
            out.extend(order);
        }
        out
    }

    let mut best: Option<Vec<u8>> = None;
    for a in 0..7 {
        for b in (a + 1)..7 {
            for c in (b + 1)..7 {
                for d in (c + 1)..7 {
                    for e in (d + 1)..7 {
                        let five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
                        let v = eval5(&five);
                        if best.as_ref().map_or(true, |x| v > *x) {
                            best = Some(v);
                        }
                    }
                }
            }
        }
    }
    best.unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Rng;

    fn ev(s: &str) -> u32 {
        eval7(&parse_cards(s))
    }

    /// The real correctness test: agreement with the reference on the *ordering*
    /// of random hands. The two evaluators pack scores differently, so only the
    /// comparison result is meaningful.
    #[test]
    fn fuzz_against_reference() {
        let mut rng = Rng::new(0x5EED_1234);
        let mut deck: [u8; 52] = std::array::from_fn(|i| i as u8);
        let mut mismatches = 0;

        for _ in 0..200_000 {
            for i in 0..14 {
                let j = i + rng.below((52 - i) as u32) as usize;
                deck.swap(i, j);
            }
            let a = &deck[0..7];
            let b = &deck[7..14];

            let fast = eval7(a).cmp(&eval7(b));
            let slow = eval7_reference(a).cmp(&eval7_reference(b));
            if fast != slow {
                mismatches += 1;
                if mismatches < 4 {
                    eprintln!("mismatch: {a:?} vs {b:?} fast={fast:?} slow={slow:?}");
                }
            }
        }
        assert_eq!(mismatches, 0, "{mismatches} ordering mismatches vs reference");
    }

    /// Same fuzz, but both hands share a five-card board — the only situation
    /// that produces real ties, and therefore the one equity numbers hinge on.
    #[test]
    fn fuzz_shared_board_against_reference() {
        let mut rng = Rng::new(0xB0A2_D000);
        let mut deck: [u8; 52] = std::array::from_fn(|i| i as u8);
        let mut mismatches = 0;
        let mut ties = 0;

        for _ in 0..200_000 {
            for i in 0..9 {
                let j = i + rng.below((52 - i) as u32) as usize;
                deck.swap(i, j);
            }
            // deck[0..5] = board, deck[5..7] and deck[7..9] = the two hands
            let mut a = [0u8; 7];
            let mut b = [0u8; 7];
            a[0..5].copy_from_slice(&deck[0..5]);
            b[0..5].copy_from_slice(&deck[0..5]);
            a[5..7].copy_from_slice(&deck[5..7]);
            b[5..7].copy_from_slice(&deck[7..9]);

            let fast = eval7(&a).cmp(&eval7(&b));
            let slow = eval7_reference(&a).cmp(&eval7_reference(&b));
            if fast == std::cmp::Ordering::Equal {
                ties += 1;
            }
            if fast != slow {
                mismatches += 1;
                if mismatches < 4 {
                    eprintln!("mismatch: {a:?} vs {b:?} fast={fast:?} slow={slow:?}");
                }
            }
        }
        assert_eq!(mismatches, 0, "{mismatches} mismatches vs reference");
        assert!(ties > 1000, "only {ties} ties sampled — tie paths under-tested");
    }

    #[test]
    fn categories() {
        assert_eq!(ev("AsKsQsJsTs2h3d") >> 20, STRAIGHT_FLUSH);
        assert_eq!(ev("As5s4s3s2s9h9d") >> 20, STRAIGHT_FLUSH); // wheel flush
        assert_eq!(ev("AsAhAdAc2h3d4s") >> 20, QUADS);
        assert_eq!(ev("AsAhAdKcKh3d4s") >> 20, FULL_HOUSE);
        assert_eq!(ev("AsAhAdKcKhQdQs") >> 20, FULL_HOUSE); // two trips -> boat
        assert_eq!(ev("As9s7s5s2s3d4h") >> 20, FLUSH);
        assert_eq!(ev("AsKhQdJcTs2h3d") >> 20, STRAIGHT);
        assert_eq!(ev("Ah2d3c4s5h9d8c") >> 20, STRAIGHT); // wheel
        assert_eq!(ev("AsAhAd5c9h2d3s") >> 20, TRIPS);
        assert_eq!(ev("AsAhKdKc9h2d3s") >> 20, TWO_PAIR);
        assert_eq!(ev("AsAh8dKc9h2d3s") >> 20, PAIR);
        assert_eq!(ev("As7h8dKc9h2d3s") >> 20, HIGH_CARD);
    }

    #[test]
    fn ordering() {
        assert!(ev("AsKsQsJsTs2h3d") > ev("AsAhAdAc2h3d4s"));
        assert!(ev("AsAhAdAc2h3d4s") > ev("AsAhAdKcKh3d4s"));
        assert!(ev("AsAhAdKcKh3d4s") > ev("As9s7s5s2s3d4h"));
        assert!(ev("As9s7s5s2s3d4h") > ev("AsKhQdJcTs2h3d"));
        assert!(ev("AsKhQdJcTs2h3d") > ev("AsAhAd5c9h2d3s"));
        assert!(ev("AsAhAd5c9h2d3s") > ev("AsAhKdKc9h2d3s"));
        assert!(ev("AsAhKdKc9h2d3s") > ev("AsAh8dKc9h2d3s"));
        assert!(ev("AsAh8dKc9h2d3s") > ev("As7h8dKc9h2d3s"));
        // kickers
        assert!(ev("AsAhKdQc9h2d3s") > ev("AsAhKdJc9h2d3s"));
        // the wheel is the worst straight
        assert!(ev("Ah2d3c4s5h9d8c") < ev("6h2d3c4s5h9d8c"));
    }

    #[test]
    fn best_five_of_seven() {
        // A board flush must beat the pair the hole cards make.
        assert_eq!(ev("2s5s9sJsKs7h7d") >> 20, FLUSH);
    }
}
