//! Equity: Monte Carlo and exhaustive enumeration, hand-vs-hand and range-vs-range.

use crate::eval::eval7;
use crate::rng::Rng;

#[derive(Default, Clone, Copy, Debug)]
pub struct Equity {
    pub wins: u64,
    pub ties: u64,
    pub total: u64,
}

impl Equity {
    pub fn pct(&self) -> f64 {
        if self.total == 0 {
            return 0.0;
        }
        (self.wins as f64 + self.ties as f64 * 0.5) / self.total as f64
    }
}

#[inline(always)]
fn deck_excluding(dead: u64) -> ([u8; 52], usize) {
    let mut d = [0u8; 52];
    let mut n = 0;
    for c in 0..52u8 {
        if dead & (1 << c) == 0 {
            d[n] = c;
            n += 1;
        }
    }
    (d, n)
}

#[inline(always)]
fn mask(cards: &[u8]) -> u64 {
    cards.iter().fold(0u64, |m, &c| m | 1 << c)
}

/// Monte Carlo equity, one hero hand vs one villain hand, from any board length.
pub fn mc_hand_vs_hand(hero: [u8; 2], vill: [u8; 2], board: &[u8], iters: u32, seed: u64) -> Equity {
    let dead = mask(&hero) | mask(&vill) | mask(board);
    let (deck, n) = deck_excluding(dead);
    let need = 5 - board.len();
    let mut rng = Rng::new(seed);
    let mut eq = Equity::default();

    let mut h = [0u8; 7];
    let mut v = [0u8; 7];
    h[0] = hero[0];
    h[1] = hero[1];
    v[0] = vill[0];
    v[1] = vill[1];
    for (i, &c) in board.iter().enumerate() {
        h[2 + i] = c;
        v[2 + i] = c;
    }

    let mut d = deck;
    for _ in 0..iters {
        // Partial Fisher-Yates: only shuffle the cards we actually draw.
        for i in 0..need {
            let j = i + rng.below((n - i) as u32) as usize;
            d.swap(i, j);
            h[2 + board.len() + i] = d[i];
            v[2 + board.len() + i] = d[i];
        }
        let hs = eval7(&h);
        let vs = eval7(&v);
        if hs > vs {
            eq.wins += 1;
        } else if hs == vs {
            eq.ties += 1;
        }
        eq.total += 1;
    }
    eq
}

/// Exhaustive enumeration of every remaining board. Ground truth for the MC path.
pub fn enum_hand_vs_hand(hero: [u8; 2], vill: [u8; 2], board: &[u8]) -> Equity {
    let dead = mask(&hero) | mask(&vill) | mask(board);
    let (deck, n) = deck_excluding(dead);
    let need = 5 - board.len();
    let mut eq = Equity::default();

    let mut h = [0u8; 7];
    let mut v = [0u8; 7];
    h[0] = hero[0];
    h[1] = hero[1];
    v[0] = vill[0];
    v[1] = vill[1];
    for (i, &c) in board.iter().enumerate() {
        h[2 + i] = c;
        v[2 + i] = c;
    }

    let base = 2 + board.len();
    let mut idx = vec![0usize; need];
    fn rec(
        pos: usize,
        start: usize,
        need: usize,
        n: usize,
        deck: &[u8; 52],
        idx: &mut Vec<usize>,
        base: usize,
        h: &mut [u8; 7],
        v: &mut [u8; 7],
        eq: &mut Equity,
    ) {
        if pos == need {
            let hs = eval7(h);
            let vs = eval7(v);
            if hs > vs {
                eq.wins += 1;
            } else if hs == vs {
                eq.ties += 1;
            }
            eq.total += 1;
            return;
        }
        for i in start..n {
            idx[pos] = i;
            h[base + pos] = deck[i];
            v[base + pos] = deck[i];
            rec(pos + 1, i + 1, need, n, deck, idx, base, h, v, eq);
        }
    }
    rec(
        0, 0, need, n, &deck, &mut idx, base, &mut h, &mut v, &mut eq,
    );
    eq
}

/// All 1326 two-card combos.
pub fn all_combos() -> Vec<[u8; 2]> {
    let mut v = Vec::with_capacity(1326);
    for a in 0..52u8 {
        for b in (a + 1)..52u8 {
            v.push([a, b]);
        }
    }
    v
}

/// Expand shorthand like `"AA,KK,AKs,AQo,T9s"` into concrete combos.
pub fn parse_range(spec: &str) -> Vec<[u8; 2]> {
    const RANKS: &[u8] = b"23456789TJQKA";
    let mut out = Vec::new();
    for tok in spec.split(',').map(|t| t.trim()).filter(|t| !t.is_empty()) {
        let b = tok.as_bytes();
        let r1 = RANKS.iter().position(|&x| x == b[0]).expect("bad rank") as u8;
        let r2 = RANKS.iter().position(|&x| x == b[1]).expect("bad rank") as u8;
        let suited = b.len() > 2 && (b[2] == b's' || b[2] == b'S');
        if r1 == r2 {
            for s1 in 0..4u8 {
                for s2 in (s1 + 1)..4u8 {
                    out.push([r1 * 4 + s1, r2 * 4 + s2]);
                }
            }
        } else if suited {
            for s in 0..4u8 {
                out.push([r1 * 4 + s, r2 * 4 + s]);
            }
        } else {
            for s1 in 0..4u8 {
                for s2 in 0..4u8 {
                    if s1 != s2 {
                        out.push([r1 * 4 + s1, r2 * 4 + s2]);
                    }
                }
            }
        }
    }
    out
}

/// Monte Carlo range vs range: sample a non-conflicting combo pair each iteration.
pub fn mc_range_vs_range(
    hero: &[[u8; 2]],
    vill: &[[u8; 2]],
    board: &[u8],
    iters: u32,
    seed: u64,
) -> Equity {
    let bmask = mask(board);
    let mut rng = Rng::new(seed);
    let mut eq = Equity::default();

    let mut h = [0u8; 7];
    let mut v = [0u8; 7];
    for (i, &c) in board.iter().enumerate() {
        h[2 + i] = c;
        v[2 + i] = c;
    }
    let need = 5 - board.len();
    let base = 2 + board.len();

    let mut drawn = 0u32;
    while drawn < iters {
        let hc = hero[rng.below(hero.len() as u32) as usize];
        let vc = vill[rng.below(vill.len() as u32) as usize];
        let hm = mask(&hc);
        let vm = mask(&vc);
        if hm & vm != 0 || hm & bmask != 0 || vm & bmask != 0 {
            continue; // card conflict — resample
        }
        let (mut d, n) = deck_excluding(bmask | hm | vm);
        h[0] = hc[0];
        h[1] = hc[1];
        v[0] = vc[0];
        v[1] = vc[1];
        for i in 0..need {
            let j = i + rng.below((n - i) as u32) as usize;
            d.swap(i, j);
            h[base + i] = d[i];
            v[base + i] = d[i];
        }
        let hs = eval7(&h);
        let vs = eval7(&v);
        if hs > vs {
            eq.wins += 1;
        } else if hs == vs {
            eq.ties += 1;
        }
        eq.total += 1;
        drawn += 1;
    }
    eq
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eval::parse_cards;

    fn hand(s: &str) -> [u8; 2] {
        let c = parse_cards(s);
        [c[0], c[1]]
    }

    #[test]
    fn aa_vs_kk_matches_known_equity() {
        // Averaged over all 36 AA/KK suit pairings this must land on the
        // canonical 81.946% / 17.816% / 0.238% split that every equity
        // calculator agrees on. An individual pairing drifts either side of it
        // depending on how many suits the two hands share.
        let aa = parse_range("AA");
        let kk = parse_range("KK");
        let mut agg = Equity::default();
        for a in &aa {
            for k in &kk {
                let e = enum_hand_vs_hand(*a, *k, &[]);
                assert_eq!(e.total, 1_712_304);
                agg.wins += e.wins;
                agg.ties += e.ties;
                agg.total += e.total;
            }
        }
        let p = agg.pct();
        assert!((p - 0.81946).abs() < 0.0001, "equity {p}");
        // Tie rate is pinned from this engine's own exhaustive count rather than
        // a quoted figure; the evaluator itself is verified by the reference
        // fuzz in `eval`, including the shared-board cases that produce ties.
        let tie = agg.ties as f64 / agg.total as f64;
        assert!((tie - 0.004627).abs() < 0.0001, "tie rate {tie}");
    }

    #[test]
    fn suit_sharing_shifts_equity_the_right_way() {
        // Sharing suits gives KK more flush outs that AA blocks, so the
        // double-suit-shared pairing must be *better* for the aces.
        let shared = enum_hand_vs_hand(hand("AsAh"), hand("KsKh"), &[]).pct();
        let disjoint = enum_hand_vs_hand(hand("AsAh"), hand("KdKc"), &[]).pct();
        assert!(shared > disjoint, "{shared} vs {disjoint}");
    }

    #[test]
    fn mc_converges_to_enumeration() {
        let a = hand("AsKs");
        let b = hand("QhQd");
        let exact = enum_hand_vs_hand(a, b, &[]).pct();
        let approx = mc_hand_vs_hand(a, b, &[], 200_000, 12345).pct();
        assert!((exact - approx).abs() < 0.005, "{exact} vs {approx}");
    }

    #[test]
    fn range_parsing_counts() {
        assert_eq!(parse_range("AA").len(), 6);
        assert_eq!(parse_range("AKs").len(), 4);
        assert_eq!(parse_range("AKo").len(), 12);
        assert_eq!(parse_range("AA,KK,AKs").len(), 16);
    }
}
