//! A real river subgame solver (vector-form CFR with regret matching).
//!
//! This is the load-bearing feasibility test for the postflop plan: if solving
//! one street of one spot is cheap, precomputing a library of spots offline is
//! an arithmetic problem rather than a research problem. Everything here is
//! exact — no bucketing, no sampling — so the throughput number is honest.
//!
//! Terminal values use the standard O(n log n) sorted sweep with card-removal
//! correction rather than an O(n^2) pairwise matrix.

use crate::eval::eval7;

#[derive(Clone, Copy, Debug)]
pub enum Node {
    /// `children[a]` is the node index reached by action `a`.
    Decision { player: usize, first_child: usize, n_actions: usize },
    Showdown { pot: f64, inv: [f64; 2] },
    Fold { folder: usize, pot: f64, inv: [f64; 2] },
}

pub struct Solver {
    pub nodes: Vec<Node>,
    pub children: Vec<usize>,
    /// Per player: the combos in their range (indices into `strength`).
    pub combos: [Vec<[u8; 2]>; 2],
    pub strength: [Vec<u32>; 2],
    /// Combo indices sorted ascending by hand strength.
    order: [Vec<usize>; 2],
    regrets: Vec<Vec<f64>>,
    strat_sum: Vec<Vec<f64>>,
    pub iterations: u64,
}

fn strengths(combos: &[[u8; 2]], board: &[u8]) -> Vec<u32> {
    let mut seven = [0u8; 7];
    seven[2..7].copy_from_slice(&board[0..5]);
    combos
        .iter()
        .map(|c| {
            seven[0] = c[0];
            seven[1] = c[1];
            eval7(&seven)
        })
        .collect()
}

/// Reach mass of the opponent that a given hero combo can actually face,
/// plus the parts of it the hero beats and loses to.
struct Terms {
    total: Vec<f64>,
    win: Vec<f64>,
    lose: Vec<f64>,
}

impl Solver {
    /// Build a standard single-raise river tree:
    ///   OOP: check | bet          IP (vs check): check | bet
    ///   IP (vs bet): fold | call | raise      OOP (vs raise): fold | call
    pub fn new_river(
        board: &[u8],
        oop_range: Vec<[u8; 2]>,
        ip_range: Vec<[u8; 2]>,
        pot: f64,
        bet: f64,
        raise: f64,
    ) -> Self {
        let mut nodes = Vec::new();
        let mut children = Vec::new();

        // Indices are assigned by hand so the tree stays readable.
        // 0: OOP first action        1: IP vs check        2: IP vs bet
        // 3: OOP vs raise
        nodes.push(Node::Decision { player: 0, first_child: 0, n_actions: 2 }); // 0
        nodes.push(Node::Decision { player: 1, first_child: 2, n_actions: 2 }); // 1
        nodes.push(Node::Decision { player: 1, first_child: 4, n_actions: 3 }); // 2
        nodes.push(Node::Decision { player: 0, first_child: 7, n_actions: 2 }); // 3

        let t = |n: Node, nodes: &mut Vec<Node>| {
            nodes.push(n);
            nodes.len() - 1
        };
        // node 0 children: check -> 1, bet -> 2
        children.push(1);
        children.push(2);
        // node 1 children: check -> showdown(pot), bet -> (IP bets after check)
        let sd0 = t(Node::Showdown { pot, inv: [0.0, 0.0] }, &mut nodes);
        children.push(sd0);
        // IP bets after check -> OOP fold/call. Model as a decision node appended later.
        let oop_vs_delayed = nodes.len();
        nodes.push(Node::Decision { player: 0, first_child: 9, n_actions: 2 });
        children.push(oop_vs_delayed);
        // node 2 children: fold -> IP folds, call -> showdown, raise -> node 3
        let ip_fold = t(Node::Fold { folder: 1, pot, inv: [bet, 0.0] }, &mut nodes);
        let sd_call = t(Node::Showdown { pot, inv: [bet, bet] }, &mut nodes);
        children.push(ip_fold);
        children.push(sd_call);
        children.push(3);
        // node 3 children: fold -> OOP folds, call -> showdown at raise size
        let oop_fold = t(Node::Fold { folder: 0, pot, inv: [bet, raise] }, &mut nodes);
        let sd_raise = t(Node::Showdown { pot, inv: [raise, raise] }, &mut nodes);
        children.push(oop_fold);
        children.push(sd_raise);
        // delayed-bet subtree children: OOP fold -> IP wins, OOP call -> showdown
        let oop_fold2 = t(Node::Fold { folder: 0, pot, inv: [0.0, bet] }, &mut nodes);
        let sd_delayed = t(Node::Showdown { pot, inv: [bet, bet] }, &mut nodes);
        children.push(oop_fold2);
        children.push(sd_delayed);

        let bmask = board.iter().fold(0u64, |m, &c| m | 1 << c);
        let live = |r: Vec<[u8; 2]>| -> Vec<[u8; 2]> {
            r.into_iter()
                .filter(|c| bmask & (1 << c[0]) == 0 && bmask & (1 << c[1]) == 0)
                .collect()
        };
        let oop_range = live(oop_range);
        let ip_range = live(ip_range);

        let s0 = strengths(&oop_range, board);
        let s1 = strengths(&ip_range, board);
        let mut o0: Vec<usize> = (0..oop_range.len()).collect();
        let mut o1: Vec<usize> = (0..ip_range.len()).collect();
        o0.sort_by_key(|&i| s0[i]);
        o1.sort_by_key(|&i| s1[i]);

        let sizes: Vec<usize> = nodes
            .iter()
            .map(|n| match n {
                Node::Decision { player, n_actions, .. } => {
                    n_actions * if *player == 0 { oop_range.len() } else { ip_range.len() }
                }
                _ => 0,
            })
            .collect();

        Solver {
            regrets: sizes.iter().map(|&s| vec![0.0; s]).collect(),
            strat_sum: sizes.iter().map(|&s| vec![0.0; s]).collect(),
            nodes,
            children,
            combos: [oop_range, ip_range],
            strength: [s0, s1],
            order: [o0, o1],
            iterations: 0,
        }
    }

    pub fn n_combos(&self, p: usize) -> usize {
        self.combos[p].len()
    }

    /// Decision nodes only — what the strategy table would actually store.
    pub fn n_decision_nodes(&self) -> usize {
        self.nodes
            .iter()
            .filter(|n| matches!(n, Node::Decision { .. }))
            .count()
    }

    /// Sorted sweep: for every hero combo, how much opponent reach it faces,
    /// beats, and loses to — with combos sharing a card removed.
    fn terms(&self, hero: usize, reach_v: &[f64]) -> Terms {
        let vill = 1 - hero;
        let nh = self.combos[hero].len();
        let mut total = vec![0.0; nh];
        let mut win = vec![0.0; nh];
        let mut lose = vec![0.0; nh];

        // Total reach, minus villain combos blocked by each hero card.
        let mut all = 0.0;
        let mut card_all = [0.0f64; 52];
        for (i, c) in self.combos[vill].iter().enumerate() {
            all += reach_v[i];
            card_all[c[0] as usize] += reach_v[i];
            card_all[c[1] as usize] += reach_v[i];
        }
        for (h, c) in self.combos[hero].iter().enumerate() {
            total[h] = all - card_all[c[0] as usize] - card_all[c[1] as usize];
        }

        // Ascending sweep -> villain hands the hero beats.
        let mut sum = 0.0;
        let mut card = [0.0f64; 52];
        let mut j = 0usize;
        let ov = &self.order[vill];
        for &h in &self.order[hero] {
            let s = self.strength[hero][h];
            while j < ov.len() && self.strength[vill][ov[j]] < s {
                let vi = ov[j];
                let c = self.combos[vill][vi];
                sum += reach_v[vi];
                card[c[0] as usize] += reach_v[vi];
                card[c[1] as usize] += reach_v[vi];
                j += 1;
            }
            let c = self.combos[hero][h];
            win[h] = sum - card[c[0] as usize] - card[c[1] as usize];
        }

        // Descending sweep -> villain hands that beat the hero.
        let mut sum = 0.0;
        let mut card = [0.0f64; 52];
        let mut j = ov.len();
        for &h in self.order[hero].iter().rev() {
            let s = self.strength[hero][h];
            while j > 0 && self.strength[vill][ov[j - 1]] > s {
                let vi = ov[j - 1];
                let c = self.combos[vill][vi];
                sum += reach_v[vi];
                card[c[0] as usize] += reach_v[vi];
                card[c[1] as usize] += reach_v[vi];
                j -= 1;
            }
            let c = self.combos[hero][h];
            lose[h] = sum - card[c[0] as usize] - card[c[1] as usize];
        }

        Terms { total, win, lose }
    }

    fn terminal_values(&self, node: usize, reach: &[Vec<f64>; 2]) -> [Vec<f64>; 2] {
        match self.nodes[node] {
            Node::Showdown { pot, inv } => {
                let full = pot + inv[0] + inv[1];
                let half = full / 2.0;
                let mut out = [vec![0.0; self.combos[0].len()], vec![0.0; self.combos[1].len()]];
                for p in 0..2 {
                    let t = self.terms(p, &reach[1 - p]);
                    for h in 0..self.combos[p].len() {
                        out[p][h] =
                            t.total[h] * (half - inv[p]) + half * (t.win[h] - t.lose[h]);
                    }
                }
                out
            }
            Node::Fold { folder, pot, inv } => {
                let mut out = [vec![0.0; self.combos[0].len()], vec![0.0; self.combos[1].len()]];
                for p in 0..2 {
                    let t = self.terms(p, &reach[1 - p]);
                    let v = if p == folder { -inv[p] } else { pot + inv[1 - p] };
                    for h in 0..self.combos[p].len() {
                        out[p][h] = t.total[h] * v;
                    }
                }
                out
            }
            Node::Decision { .. } => unreachable!(),
        }
    }

    fn strategy(&self, node: usize, player: usize, n_actions: usize) -> Vec<f64> {
        let n = self.combos[player].len();
        let mut s = vec![0.0; n * n_actions];
        for h in 0..n {
            let base = h * n_actions;
            let mut pos = 0.0;
            for a in 0..n_actions {
                let r = self.regrets[node][base + a];
                if r > 0.0 {
                    pos += r;
                }
            }
            if pos > 0.0 {
                for a in 0..n_actions {
                    let r = self.regrets[node][base + a];
                    s[base + a] = if r > 0.0 { r / pos } else { 0.0 };
                }
            } else {
                for a in 0..n_actions {
                    s[base + a] = 1.0 / n_actions as f64;
                }
            }
        }
        s
    }

    fn cfr(&mut self, node: usize, reach: &[Vec<f64>; 2]) -> [Vec<f64>; 2] {
        let (player, first_child, n_actions) = match self.nodes[node] {
            Node::Decision { player, first_child, n_actions } => (player, first_child, n_actions),
            _ => return self.terminal_values(node, reach),
        };
        let n = self.combos[player].len();
        let strat = self.strategy(node, player, n_actions);

        let mut node_val = [vec![0.0; self.combos[0].len()], vec![0.0; self.combos[1].len()]];
        let mut action_val = vec![vec![0.0; n]; n_actions];

        for a in 0..n_actions {
            let mut sub = [reach[0].clone(), reach[1].clone()];
            for h in 0..n {
                sub[player][h] *= strat[h * n_actions + a];
            }
            let child = self.children[first_child + a];
            let v = self.cfr(child, &sub);
            for h in 0..n {
                action_val[a][h] = v[player][h];
                node_val[player][h] += strat[h * n_actions + a] * v[player][h];
            }
            let opp = 1 - player;
            for h in 0..self.combos[opp].len() {
                node_val[opp][h] += v[opp][h];
            }
        }

        for h in 0..n {
            let base = h * n_actions;
            for a in 0..n_actions {
                self.regrets[node][base + a] += action_val[a][h] - node_val[player][h];
                self.strat_sum[node][base + a] += reach[player][h] * strat[base + a];
            }
        }
        node_val
    }

    pub fn run(&mut self, iters: u32) {
        let r0 = vec![1.0; self.combos[0].len()];
        let r1 = vec![1.0; self.combos[1].len()];
        for _ in 0..iters {
            let reach = [r0.clone(), r1.clone()];
            self.cfr(0, &reach);
            self.iterations += 1;
        }
    }

    /// Average strategy at a node, the thing that actually converges.
    pub fn average_strategy(&self, node: usize) -> Vec<f64> {
        let (player, n_actions) = match self.nodes[node] {
            Node::Decision { player, n_actions, .. } => (player, n_actions),
            _ => return vec![],
        };
        let n = self.combos[player].len();
        let mut out = vec![0.0; n * n_actions];
        for h in 0..n {
            let base = h * n_actions;
            let sum: f64 = (0..n_actions).map(|a| self.strat_sum[node][base + a]).sum();
            for a in 0..n_actions {
                out[base + a] = if sum > 0.0 {
                    self.strat_sum[node][base + a] / sum
                } else {
                    1.0 / n_actions as f64
                };
            }
        }
        out
    }

    /// Value to `player` when `br_player` maximises and everyone else follows
    /// the average strategy. Pass `br_player = 2` for "nobody maximises", which
    /// gives the value of the average strategy itself.
    ///
    /// Normalised to chips per hand: the raw recursion sums over every opponent
    /// combo, so it must be divided by the opponent range size as well as the
    /// hero's, or the number just tracks how big the ranges are.
    fn value(&self, player: usize, br_player: usize) -> f64 {
        let reach = [
            vec![1.0; self.combos[0].len()],
            vec![1.0; self.combos[1].len()],
        ];
        let v = self.br(0, &reach, br_player);
        let n = self.combos[player].len() as f64;
        let n_opp = self.combos[1 - player].len() as f64;
        v[player].iter().sum::<f64>() / n / n_opp
    }

    /// Chips per hand that `br_player` gains by deviating optimally.
    pub fn best_response(&self, br_player: usize) -> f64 {
        self.value(br_player, br_player)
    }

    /// Exploitability of the current average strategy, in chips per hand.
    /// This is the number that must go to zero; it is the standard solver
    /// metric and is what "how converged is it" actually means.
    pub fn exploitability(&self) -> f64 {
        let v0 = self.value(0, 2);
        let v1 = self.value(1, 2);
        (self.best_response(0) - v0) + (self.best_response(1) - v1)
    }

    fn br(&self, node: usize, reach: &[Vec<f64>; 2], br_player: usize) -> [Vec<f64>; 2] {
        let (player, first_child, n_actions) = match self.nodes[node] {
            Node::Decision { player, first_child, n_actions } => (player, first_child, n_actions),
            _ => return self.terminal_values(node, reach),
        };
        let n = self.combos[player].len();
        let strat = self.average_strategy(node);
        let mut vals = Vec::with_capacity(n_actions);
        let mut opp_acc = vec![0.0; self.combos[1 - player].len()];

        for a in 0..n_actions {
            let mut sub = [reach[0].clone(), reach[1].clone()];
            if player != br_player {
                for h in 0..n {
                    sub[player][h] *= strat[h * n_actions + a];
                }
            }
            let v = self.br(self.children[first_child + a], &sub, br_player);
            for h in 0..opp_acc.len() {
                opp_acc[h] += v[1 - player][h];
            }
            vals.push(v[player].clone());
        }

        let mut own = vec![0.0; n];
        for h in 0..n {
            if player == br_player {
                own[h] = vals.iter().map(|v| v[h]).fold(f64::NEG_INFINITY, f64::max);
            } else {
                own[h] = (0..n_actions).map(|a| strat[h * n_actions + a] * vals[a][h]).sum();
            }
        }

        let mut out = [vec![0.0; self.combos[0].len()], vec![0.0; self.combos[1].len()]];
        out[player] = own;
        out[1 - player] = opp_acc;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::equity::parse_range;
    use crate::eval::parse_cards;

    #[test]
    fn cfr_reduces_exploitability() {
        let board = parse_cards("2c7d9hJsKd");
        let r = parse_range("AA,KK,QQ,JJ,TT,99,88,AKs,AQs,AJs,KQs,AKo,AQo");
        let mut s = Solver::new_river(&board, r.clone(), r, 10.0, 7.0, 21.0);

        s.run(10);
        let early = s.exploitability();
        s.run(400);
        let late = s.exploitability();

        assert!(late < early, "exploitability should fall: {early} -> {late}");
    }

    #[test]
    fn nuts_never_folds() {
        // Straight flush on a monotone board vs a range that mostly whiffs:
        // the solver must not fold the stone nuts to a bet.
        let board = parse_cards("2c3c4c9dKh");
        let hero = parse_range("AA,KK,QQ,JJ");
        let vill = parse_range("AA,KK,QQ,JJ,TT,99");
        let mut s = Solver::new_river(&board, hero, vill, 10.0, 7.0, 21.0);
        s.run(300);

        // Node 2 is IP facing a bet: actions [fold, call, raise].
        let strat = s.average_strategy(2);
        let best = (0..s.n_combos(1)).max_by_key(|&i| s.strength[1][i]).unwrap();
        let fold_freq = strat[best * 3];
        assert!(fold_freq < 0.05, "best hand folding {fold_freq} of the time");
    }
}
