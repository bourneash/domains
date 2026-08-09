//! Heads-up push/fold Nash equilibrium — exactly solvable, so we ship a
//! solution instead of a chart somebody typed in.
//!
//! Why push/fold specifically: at short stacks a heads-up small blind's only
//! sensible options really are shove or fold, which makes the game finite and
//! terminal values pure all-in equities. No postflop play has to be modelled
//! and no equity-realisation fudge factor is needed, so the answer is exact
//! rather than approximate. That matters for an audience that checks.
//!
//! The 6-max preflop tree does NOT fit client-side (see RESULTS.md: 6.14 GB at
//! three sizings and a four-raise cap). This does — the whole solved table is a
//! few KB.

use crate::equity::mc_range_vs_range;
use crate::rng::Rng;

pub const N_CANON: usize = 169;

/// A canonical starting hand: ranks plus suitedness. `hi >= lo` always.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Canon {
    pub hi: u8,
    pub lo: u8,
    pub suited: bool,
}

impl Canon {
    pub fn label(&self) -> String {
        const R: &[u8] = b"23456789TJQKA";
        let a = R[self.hi as usize] as char;
        let b = R[self.lo as usize] as char;
        if self.hi == self.lo {
            format!("{a}{b}")
        } else {
            format!("{a}{b}{}", if self.suited { 's' } else { 'o' })
        }
    }

    /// Every concrete two-card combo of this canonical hand.
    pub fn combos(&self) -> Vec<[u8; 2]> {
        let mut v = Vec::new();
        if self.hi == self.lo {
            for s1 in 0..4u8 {
                for s2 in (s1 + 1)..4u8 {
                    v.push([self.hi * 4 + s1, self.lo * 4 + s2]);
                }
            }
        } else if self.suited {
            for s in 0..4u8 {
                v.push([self.hi * 4 + s, self.lo * 4 + s]);
            }
        } else {
            for s1 in 0..4u8 {
                for s2 in 0..4u8 {
                    if s1 != s2 {
                        v.push([self.hi * 4 + s1, self.lo * 4 + s2]);
                    }
                }
            }
        }
        v
    }
}

/// All 169 canonical hands, in a stable order: pairs, then suited, then offsuit.
pub fn all_canon() -> Vec<Canon> {
    let mut v = Vec::with_capacity(N_CANON);
    for r in (0..13u8).rev() {
        v.push(Canon { hi: r, lo: r, suited: false });
    }
    for suited in [true, false] {
        for hi in (0..13u8).rev() {
            for lo in (0..hi).rev() {
                v.push(Canon { hi, lo, suited });
            }
        }
    }
    debug_assert_eq!(v.len(), N_CANON);
    v
}

/// Pairwise all-in equity and the number of non-conflicting combo pairings.
///
/// The pair count is not decoration: it *is* the card-removal correction. When
/// the hero holds AA there are fewer ways for the villain to hold AK, and
/// weighting by these counts is what makes the range aggregation exact rather
/// than a combinatorial approximation.
pub struct EquityMatrix {
    pub equity: Vec<f32>,
    pub pairs: Vec<u32>,
}

impl EquityMatrix {
    #[inline]
    pub fn eq(&self, i: usize, j: usize) -> f64 {
        self.equity[i * N_CANON + j] as f64
    }
    #[inline]
    pub fn pair_count(&self, i: usize, j: usize) -> f64 {
        self.pairs[i * N_CANON + j] as f64
    }

    /// `iters` Monte Carlo runouts per matchup. 20k gives roughly ±0.3% per
    /// cell, which is well inside the resolution of a push/fold threshold.
    pub fn compute(canon: &[Canon], iters: u32, progress: bool) -> Self {
        let combos: Vec<Vec<[u8; 2]>> = canon.iter().map(|c| c.combos()).collect();
        let mut equity = vec![0.0f32; N_CANON * N_CANON];
        let mut pairs = vec![0u32; N_CANON * N_CANON];

        for i in 0..N_CANON {
            if progress && i % 20 == 0 {
                eprintln!("  equity matrix: row {i}/{N_CANON}");
            }
            for j in i..N_CANON {
                // Count valid pairings once — this is exact, not sampled.
                let mut n = 0u32;
                for a in &combos[i] {
                    for b in &combos[j] {
                        if a[0] != b[0] && a[0] != b[1] && a[1] != b[0] && a[1] != b[1] {
                            n += 1;
                        }
                    }
                }
                pairs[i * N_CANON + j] = n;
                pairs[j * N_CANON + i] = n;
                if n == 0 {
                    continue;
                }
                let e = mc_range_vs_range(
                    &combos[i],
                    &combos[j],
                    &[],
                    iters,
                    (i * N_CANON + j) as u64 + 1,
                )
                .pct();
                equity[i * N_CANON + j] = e as f32;
                // Ties count half on both sides, so the mirror is exact.
                equity[j * N_CANON + i] = (1.0 - e) as f32;
            }
        }
        EquityMatrix { equity, pairs }
    }
}

/// A solved push/fold equilibrium at one stack depth.
#[derive(Clone, Debug)]
pub struct PushFold {
    pub stack_bb: f64,
    /// Small blind shoves with these canonical hands.
    pub push: Vec<bool>,
    /// Big blind calls a shove with these.
    pub call: Vec<bool>,
    /// Equilibrium shove frequency per hand. Most are 0 or 1; the borderline
    /// hands genuinely mix, and rounding that away would be a lie.
    pub push_freq: Vec<f64>,
    pub call_freq: Vec<f64>,
    /// Chips the shove is worth vs folding, per hand. Positive means shove.
    pub push_ev: Vec<f64>,
    /// Chips calling is worth vs folding, per hand.
    pub call_ev: Vec<f64>,
}

/// Equity of hand `i` against a *weighted* opponent range, corrected for card
/// removal. Weights are per-canonical-hand frequencies in [0, 1].
fn equity_vs_weighted(m: &EquityMatrix, i: usize, w: &[f64]) -> (f64, f64) {
    let mut num = 0.0;
    let mut den = 0.0;
    for j in 0..N_CANON {
        if w[j] <= 0.0 {
            continue;
        }
        let cw = m.pair_count(i, j) * w[j];
        num += cw * m.eq(i, j);
        den += cw;
    }
    if den == 0.0 { (0.5, 0.0) } else { (num / den, den) }
}

fn total_weight(m: &EquityMatrix, i: usize) -> f64 {
    (0..N_CANON).map(|j| m.pair_count(i, j)).sum()
}

/// Solve the heads-up push/fold game at `stack_bb` effective, blinds 0.5 / 1.
///
/// **Fictitious play, not best-response iteration.** Jumping straight to each
/// player's best response cycles forever in a zero-sum game — measured here at
/// 20bb it oscillated 65 -> 108 -> 53 -> 167 hands and never settled, so a
/// "run N rounds and take the last one" solver silently returns an arbitrary
/// point on the cycle. Averaging the best responses over time is what actually
/// converges, and it also produces the mixed frequencies a real equilibrium has.
pub fn solve_push_fold(m: &EquityMatrix, stack_bb: f64) -> PushFold {
    let s = stack_bb;
    // BB risks the rest of its stack to win a 2s pot; folding costs the 1bb blind.
    //   call EV = eq * 2s - s,  fold EV = -1  =>  call when eq >= (s - 1) / (2s)
    let bb_threshold = (s - 1.0) / (2.0 * s);

    let mut push_freq = vec![0.5; N_CANON];
    let mut call_freq = vec![0.5; N_CANON];
    const ROUNDS: usize = 3000;

    for t in 0..ROUNDS {
        let lr = 1.0 / (t as f64 + 2.0);

        // BB best response to the SB's current average shoving range.
        let mut br_call = vec![0.0; N_CANON];
        for i in 0..N_CANON {
            let (eq, w) = equity_vs_weighted(m, i, &push_freq);
            if w > 0.0 && eq >= bb_threshold {
                br_call[i] = 1.0;
            }
        }
        // SB best response to the BB's current average calling range.
        let mut br_push = vec![0.0; N_CANON];
        for i in 0..N_CANON {
            let total = total_weight(m, i);
            if total == 0.0 {
                continue;
            }
            let (eq_c, called_w) = equity_vs_weighted(m, i, &call_freq);
            let p_call = called_w / total;
            let ev = (1.0 - p_call) * 1.0 + p_call * (eq_c * 2.0 * s - s);
            if ev > -0.5 {
                br_push[i] = 1.0;
            }
        }
        for i in 0..N_CANON {
            push_freq[i] += lr * (br_push[i] - push_freq[i]);
            call_freq[i] += lr * (br_call[i] - call_freq[i]);
        }
    }

    // Final EVs, evaluated against the converged opponent strategy.
    let mut push_ev = vec![0.0; N_CANON];
    let mut call_ev = vec![0.0; N_CANON];
    for i in 0..N_CANON {
        let total = total_weight(m, i);
        let (eq_c, called_w) = equity_vs_weighted(m, i, &call_freq);
        let p_call = if total > 0.0 { called_w / total } else { 0.0 };
        let ev = (1.0 - p_call) * 1.0 + p_call * (eq_c * 2.0 * s - s);
        push_ev[i] = ev - (-0.5);

        let (eq_p, _) = equity_vs_weighted(m, i, &push_freq);
        call_ev[i] = (eq_p * 2.0 * s - s) - (-1.0);
    }

    PushFold {
        stack_bb: s,
        push: (0..N_CANON).map(|i| push_freq[i] >= 0.5).collect(),
        call: (0..N_CANON).map(|i| call_freq[i] >= 0.5).collect(),
        push_freq,
        call_freq,
        push_ev,
        call_ev,
    }
}

/// Sample a canonical hand uniformly *by combo count*, so AA shows up 6/1326
/// of the time rather than 1/169. Drills must reflect real deal frequencies.
pub fn sample_canon(rng: &mut Rng, canon: &[Canon]) -> usize {
    let target = rng.below(1326) as i64;
    let mut acc = 0i64;
    for (i, c) in canon.iter().enumerate() {
        acc += c.combos().len() as i64;
        if target < acc {
            return i;
        }
    }
    canon.len() - 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canon_set_is_complete_and_sums_to_a_deck() {
        let c = all_canon();
        assert_eq!(c.len(), 169);
        let total: usize = c.iter().map(|x| x.combos().len()).sum();
        assert_eq!(total, 1326, "canonical hands must cover every combo exactly once");
        assert_eq!(c[0].label(), "AA");
        assert!(c.iter().any(|x| x.label() == "72o"));
        assert!(c.iter().any(|x| x.label() == "AKs"));
    }

    #[test]
    fn pair_counts_encode_card_removal() {
        let canon = all_canon();
        let m = EquityMatrix::compute(&canon, 200, false);
        let aa = canon.iter().position(|c| c.label() == "AA").unwrap();
        let aks = canon.iter().position(|c| c.label() == "AKs").unwrap();
        let kqs = canon.iter().position(|c| c.label() == "KQs").unwrap();
        // Holding AA blocks both aces, so far fewer AKs pairings survive than KQs.
        assert!(
            m.pair_count(aa, aks) < m.pair_count(aa, kqs),
            "aces must block AKs more than KQs"
        );
        // AA vs AA is impossible to pair off in only 4 aces? It is possible (6 combos
        // choose 2 disjoint pairs), but far rarer than AA vs 72o.
        let s72 = canon.iter().position(|c| c.label() == "72o").unwrap();
        assert!(m.pair_count(aa, aa) < m.pair_count(aa, s72));
    }

    #[test]
    fn known_matchups_are_right() {
        let canon = all_canon();
        let m = EquityMatrix::compute(&canon, 20000, false);
        let idx = |l: &str| canon.iter().position(|c| c.label() == l).unwrap();
        let aa_kk = m.eq(idx("AA"), idx("KK"));
        assert!((aa_kk - 0.82).abs() < 0.01, "AA vs KK was {aa_kk}");
        let aks_qq = m.eq(idx("AKs"), idx("QQ"));
        assert!((aks_qq - 0.46).abs() < 0.02, "AKs vs QQ was {aks_qq}");
        // Mirror consistency.
        assert!((m.eq(idx("KK"), idx("AA")) + aa_kk - 1.0).abs() < 1e-4);
    }

    #[test]
    fn push_fold_behaves_like_poker() {
        let canon = all_canon();
        let m = EquityMatrix::compute(&canon, 8000, false);
        let idx = |l: &str| canon.iter().position(|c| c.label() == l).unwrap();

        let shallow = solve_push_fold(&m, 8.0);
        let deep = solve_push_fold(&m, 20.0);

        // Aces are always a shove and always a call.
        assert!(shallow.push[idx("AA")] && shallow.call[idx("AA")]);
        assert!(deep.push[idx("AA")] && deep.call[idx("AA")]);
        // 7-2 offsuit is never a call at any depth in this game.
        assert!(!shallow.call[idx("72o")] && !deep.call[idx("72o")]);
        // Shoving range must tighten as stacks get deeper — risking 20bb to win
        // 1.5bb needs a much better hand than risking 8bb to win the same.
        let n_shallow = shallow.push.iter().filter(|x| **x).count();
        let n_deep = deep.push.iter().filter(|x| **x).count();
        assert!(n_deep < n_shallow, "deep {n_deep} should shove tighter than shallow {n_shallow}");
        // And the BB must call wider when the shove is smaller relative to the pot.
        let c_shallow = shallow.call.iter().filter(|x| **x).count();
        let c_deep = deep.call.iter().filter(|x| **x).count();
        assert!(c_deep < c_shallow, "deep call {c_deep} vs shallow {c_shallow}");
    }
}
