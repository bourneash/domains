//! Multi-street CFR: betting rounds separated by chance nodes that deal the
//! next board card.
//!
//! The river solver in `river` proved one street is cheap. This answers the
//! question that actually decides the postflop plan: what does it cost when
//! turn and river runouts multiply the tree out? Everything is exact except
//! where runouts are explicitly bucketed, which is a knob so the cost of that
//! abstraction can be measured rather than assumed.

use crate::eval::eval7;

#[derive(Clone, Debug)]
pub enum SNode {
    Decision { player: usize, first_child: usize, n_actions: usize },
    /// Deals one board card; `cards[i]` leads to `children[first_child + i]`.
    Chance { first_child: usize, cards: Vec<u8> },
    Showdown { ctx: usize, pot: f64, inv: [f64; 2] },
    Fold { folder: usize, pot: f64, inv: [f64; 2] },
}

/// Hand strengths for one complete five-card board.
struct Ctx {
    strength: [Vec<u32>; 2],
    order: [Vec<usize>; 2],
}

#[derive(Clone, Copy, Debug)]
pub struct BetConfig {
    pub pot: f64,
    /// Bet as a fraction of pot.
    pub bet_frac: f64,
    /// Allow a raise in response to a bet. Doubles the branching where it applies.
    pub allow_raise: bool,
    /// Runouts kept per chance node; `None` enumerates every card.
    pub runout_buckets: Option<usize>,
}

pub struct Game {
    nodes: Vec<SNode>,
    children: Vec<usize>,
    ctxs: Vec<Ctx>,
    pub combos: [Vec<[u8; 2]>; 2],
    regrets: Vec<Vec<f64>>,
    strat_sum: Vec<Vec<f64>>,
    pub iterations: u64,
}

struct Terms {
    total: Vec<f64>,
    win: Vec<f64>,
    lose: Vec<f64>,
}

impl Game {
    /// `board` is what is already out (3 cards for a flop solve, 4 for a turn
    /// solve). Remaining streets are dealt by chance nodes.
    pub fn build(
        board: &[u8],
        oop: Vec<[u8; 2]>,
        ip: Vec<[u8; 2]>,
        cfg: BetConfig,
    ) -> Self {
        let bmask = board.iter().fold(0u64, |m, &c| m | 1 << c);
        let live = |r: Vec<[u8; 2]>| -> Vec<[u8; 2]> {
            r.into_iter()
                .filter(|c| bmask & (1 << c[0]) == 0 && bmask & (1 << c[1]) == 0)
                .collect()
        };
        let mut g = Game {
            nodes: Vec::new(),
            children: Vec::new(),
            ctxs: Vec::new(),
            combos: [live(oop), live(ip)],
            regrets: Vec::new(),
            strat_sum: Vec::new(),
            iterations: 0,
        };
        let root = g.build_street(board.to_vec(), cfg.pot, cfg);
        // Root must be node 0 for the traversals; rotate it into place.
        g.nodes.swap(0, root);
        g.fix_after_swap(0, root);

        let sizes: Vec<usize> = g
            .nodes
            .iter()
            .map(|n| match n {
                SNode::Decision { player, n_actions, .. } => n_actions * g.combos[*player].len(),
                _ => 0,
            })
            .collect();
        g.regrets = sizes.iter().map(|&s| vec![0.0; s]).collect();
        g.strat_sum = sizes.iter().map(|&s| vec![0.0; s]).collect();
        g
    }

    fn fix_after_swap(&mut self, a: usize, b: usize) {
        if a == b {
            return;
        }
        for c in self.children.iter_mut() {
            if *c == a {
                *c = b;
            } else if *c == b {
                *c = a;
            }
        }
    }

    fn push_node(&mut self, n: SNode) -> usize {
        self.nodes.push(n);
        self.nodes.len() - 1
    }

    fn make_ctx(&mut self, board: &[u8]) -> usize {
        let mut seven = [0u8; 7];
        seven[2..7].copy_from_slice(&board[0..5]);
        let mut strength: [Vec<u32>; 2] = [Vec::new(), Vec::new()];
        let mut order: [Vec<usize>; 2] = [Vec::new(), Vec::new()];
        for p in 0..2 {
            strength[p] = self.combos[p]
                .iter()
                .map(|c| {
                    seven[0] = c[0];
                    seven[1] = c[1];
                    eval7(&seven)
                })
                .collect();
            let mut o: Vec<usize> = (0..self.combos[p].len()).collect();
            o.sort_by_key(|&i| strength[p][i]);
            order[p] = o;
        }
        self.ctxs.push(Ctx { strength, order });
        self.ctxs.len() - 1
    }

    /// End of a betting round with `pot` in the middle: either deal the next
    /// street, or reach showdown.
    fn continuation(&mut self, board: Vec<u8>, pot: f64, inv: [f64; 2], cfg: BetConfig) -> usize {
        if board.len() == 5 {
            let ctx = self.make_ctx(&board);
            return self.push_node(SNode::Showdown { ctx, pot: cfg.pot, inv });
        }
        let dead = board.iter().fold(0u64, |m, &c| m | 1 << c);
        let mut cards: Vec<u8> = (0..52u8).filter(|c| dead & (1 << c) == 0).collect();
        if let Some(k) = cfg.runout_buckets {
            // Even stride over the ranked deck keeps a spread of ranks and suits
            // rather than, say, only low cards.
            if k < cards.len() {
                let step = cards.len() as f64 / k as f64;
                cards = (0..k).map(|i| cards[(i as f64 * step) as usize]).collect();
            }
        }
        let node = self.push_node(SNode::Chance { first_child: 0, cards: cards.clone() });
        let first_child = self.children.len();
        for _ in 0..cards.len() {
            self.children.push(usize::MAX); // reserved, filled below
        }
        for (i, &c) in cards.iter().enumerate() {
            let mut b2 = board.clone();
            b2.push(c);
            let child = self.build_street(b2, pot, cfg);
            self.children[first_child + i] = child;
        }
        if let SNode::Chance { first_child: f, .. } = &mut self.nodes[node] {
            *f = first_child;
        }
        node
    }

    /// One betting round on `board`, then whatever comes next.
    /// OOP: check | bet.  IP vs check: check | bet.  IP vs bet: fold | call [| raise].
    fn build_street(&mut self, board: Vec<u8>, pot: f64, cfg: BetConfig) -> usize {
        let bet = pot * cfg.bet_frac;
        let raise = bet * 3.0;

        // Terminals and continuations for this round.
        let check_check = self.continuation(board.clone(), pot, [0.0, 0.0], cfg);
        let bet_call = self.continuation(board.clone(), pot + 2.0 * bet, [bet, bet], cfg);
        let delayed_call = self.continuation(board.clone(), pot + 2.0 * bet, [bet, bet], cfg);

        let ip_folds = self.push_node(SNode::Fold { folder: 1, pot, inv: [bet, 0.0] });
        let oop_folds_delayed = self.push_node(SNode::Fold { folder: 0, pot, inv: [0.0, bet] });

        // OOP facing IP's delayed bet: fold | call
        let oop_vs_delayed = self.push_node(SNode::Decision {
            player: 0,
            first_child: self.children.len(),
            n_actions: 2,
        });
        self.children.push(oop_folds_delayed);
        self.children.push(delayed_call);

        // IP facing check: check | bet
        let ip_vs_check = self.push_node(SNode::Decision {
            player: 1,
            first_child: self.children.len(),
            n_actions: 2,
        });
        self.children.push(check_check);
        self.children.push(oop_vs_delayed);

        // IP facing a bet: fold | call [| raise]
        let n_ip = if cfg.allow_raise { 3 } else { 2 };
        let raise_branch = if cfg.allow_raise {
            let raise_call =
                self.continuation(board.clone(), pot + 2.0 * raise, [raise, raise], cfg);
            let oop_folds = self.push_node(SNode::Fold { folder: 0, pot, inv: [bet, raise] });
            let oop_vs_raise = self.push_node(SNode::Decision {
                player: 0,
                first_child: self.children.len(),
                n_actions: 2,
            });
            self.children.push(oop_folds);
            self.children.push(raise_call);
            Some(oop_vs_raise)
        } else {
            None
        };
        let ip_vs_bet = self.push_node(SNode::Decision {
            player: 1,
            first_child: self.children.len(),
            n_actions: n_ip,
        });
        self.children.push(ip_folds);
        self.children.push(bet_call);
        if let Some(r) = raise_branch {
            self.children.push(r);
        }

        // OOP acts first: check | bet
        let root = self.push_node(SNode::Decision {
            player: 0,
            first_child: self.children.len(),
            n_actions: 2,
        });
        self.children.push(ip_vs_check);
        self.children.push(ip_vs_bet);
        root
    }

    // --- stats ---------------------------------------------------------

    pub fn n_nodes(&self) -> usize {
        self.nodes.len()
    }

    pub fn n_decision_nodes(&self) -> usize {
        self.nodes
            .iter()
            .filter(|n| matches!(n, SNode::Decision { .. }))
            .count()
    }

    pub fn n_showdowns(&self) -> usize {
        self.ctxs.len()
    }

    /// Strategy slots — the size of the solved output, at 1 byte per slot.
    pub fn strategy_slots(&self) -> usize {
        self.nodes
            .iter()
            .map(|n| match n {
                SNode::Decision { player, n_actions, .. } => n_actions * self.combos[*player].len(),
                _ => 0,
            })
            .sum()
    }

    /// Working-set memory: regrets + strategy sums as f64, plus strength tables.
    pub fn solver_bytes(&self) -> usize {
        let slots = self.strategy_slots();
        let strengths: usize = self
            .ctxs
            .iter()
            .map(|c| (c.strength[0].len() + c.strength[1].len()) * (4 + 8))
            .sum();
        slots * 8 * 2 + strengths
    }

    // --- solving -------------------------------------------------------

    fn showdown_terms(&self, ctx: usize, hero: usize, reach_v: &[f64]) -> Terms {
        let vill = 1 - hero;
        let c = &self.ctxs[ctx];
        let nh = self.combos[hero].len();
        let mut total = vec![0.0; nh];
        let mut win = vec![0.0; nh];
        let mut lose = vec![0.0; nh];

        let mut all = 0.0;
        let mut card_all = [0.0f64; 52];
        for (i, cc) in self.combos[vill].iter().enumerate() {
            all += reach_v[i];
            card_all[cc[0] as usize] += reach_v[i];
            card_all[cc[1] as usize] += reach_v[i];
        }
        for (h, cc) in self.combos[hero].iter().enumerate() {
            total[h] = all - card_all[cc[0] as usize] - card_all[cc[1] as usize];
        }

        let ov = &c.order[vill];
        let mut sum = 0.0;
        let mut card = [0.0f64; 52];
        let mut j = 0usize;
        for &h in &c.order[hero] {
            let s = c.strength[hero][h];
            while j < ov.len() && c.strength[vill][ov[j]] < s {
                let vi = ov[j];
                let cc = self.combos[vill][vi];
                sum += reach_v[vi];
                card[cc[0] as usize] += reach_v[vi];
                card[cc[1] as usize] += reach_v[vi];
                j += 1;
            }
            let cc = self.combos[hero][h];
            win[h] = sum - card[cc[0] as usize] - card[cc[1] as usize];
        }

        let mut sum = 0.0;
        let mut card = [0.0f64; 52];
        let mut j = ov.len();
        for &h in c.order[hero].iter().rev() {
            let s = c.strength[hero][h];
            while j > 0 && c.strength[vill][ov[j - 1]] > s {
                let vi = ov[j - 1];
                let cc = self.combos[vill][vi];
                sum += reach_v[vi];
                card[cc[0] as usize] += reach_v[vi];
                card[cc[1] as usize] += reach_v[vi];
                j -= 1;
            }
            let cc = self.combos[hero][h];
            lose[h] = sum - card[cc[0] as usize] - card[cc[1] as usize];
        }
        Terms { total, win, lose }
    }

    fn reach_mass(&self, hero: usize, reach_v: &[f64]) -> Vec<f64> {
        let vill = 1 - hero;
        let mut all = 0.0;
        let mut card_all = [0.0f64; 52];
        for (i, cc) in self.combos[vill].iter().enumerate() {
            all += reach_v[i];
            card_all[cc[0] as usize] += reach_v[i];
            card_all[cc[1] as usize] += reach_v[i];
        }
        self.combos[hero]
            .iter()
            .map(|cc| all - card_all[cc[0] as usize] - card_all[cc[1] as usize])
            .collect()
    }

    fn terminal(&self, node: usize, reach: &[Vec<f64>; 2]) -> [Vec<f64>; 2] {
        let mut out = [
            vec![0.0; self.combos[0].len()],
            vec![0.0; self.combos[1].len()],
        ];
        match &self.nodes[node] {
            SNode::Showdown { ctx, pot, inv } => {
                let full = pot + inv[0] + inv[1];
                let half = full / 2.0;
                for p in 0..2 {
                    let t = self.showdown_terms(*ctx, p, &reach[1 - p]);
                    for h in 0..self.combos[p].len() {
                        out[p][h] = t.total[h] * (half - inv[p]) + half * (t.win[h] - t.lose[h]);
                    }
                }
            }
            SNode::Fold { folder, pot, inv } => {
                for p in 0..2 {
                    let m = self.reach_mass(p, &reach[1 - p]);
                    let v = if p == *folder { -inv[p] } else { pot + inv[1 - p] };
                    for h in 0..self.combos[p].len() {
                        out[p][h] = m[h] * v;
                    }
                }
            }
            _ => unreachable!(),
        }
        out
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
            for a in 0..n_actions {
                s[base + a] = if pos > 0.0 {
                    let r = self.regrets[node][base + a];
                    if r > 0.0 {
                        r / pos
                    } else {
                        0.0
                    }
                } else {
                    1.0 / n_actions as f64
                };
            }
        }
        s
    }

    fn cfr(&mut self, node: usize, reach: &[Vec<f64>; 2]) -> [Vec<f64>; 2] {
        match self.nodes[node].clone() {
            SNode::Showdown { .. } | SNode::Fold { .. } => self.terminal(node, reach),
            SNode::Chance { first_child, cards } => {
                let n = cards.len();
                let p = 1.0 / n as f64;
                let mut out = [
                    vec![0.0; self.combos[0].len()],
                    vec![0.0; self.combos[1].len()],
                ];
                for (i, &c) in cards.iter().enumerate() {
                    // Chance probability rides in the reach vectors, so the
                    // returned values and the regrets below are already weighted.
                    let mut sub = [reach[0].clone(), reach[1].clone()];
                    for pl in 0..2 {
                        for (h, cc) in self.combos[pl].iter().enumerate() {
                            if cc[0] == c || cc[1] == c {
                                sub[pl][h] = 0.0;
                            } else {
                                sub[pl][h] *= p;
                            }
                        }
                    }
                    let v = self.cfr(self.children[first_child + i], &sub);
                    // A hand holding the dealt card cannot reach this runout.
                    // Its subtree value is meaningless, so it must contribute
                    // nothing — leaving it in puts a floor under best-response
                    // and makes exploitability plateau at a fake value.
                    for pl in 0..2 {
                        for (h, cc) in self.combos[pl].iter().enumerate() {
                            if cc[0] != c && cc[1] != c {
                                out[pl][h] += v[pl][h];
                            }
                        }
                    }
                }
                out
            }
            SNode::Decision { player, first_child, n_actions } => {
                let n = self.combos[player].len();
                let strat = self.strategy(node, player, n_actions);
                let mut node_val = [
                    vec![0.0; self.combos[0].len()],
                    vec![0.0; self.combos[1].len()],
                ];
                let mut action_val = vec![vec![0.0; n]; n_actions];

                for a in 0..n_actions {
                    let mut sub = [reach[0].clone(), reach[1].clone()];
                    for h in 0..n {
                        sub[player][h] *= strat[h * n_actions + a];
                    }
                    let v = self.cfr(self.children[first_child + a], &sub);
                    for h in 0..n {
                        action_val[a][h] = v[player][h];
                        node_val[player][h] += strat[h * n_actions + a] * v[player][h];
                    }
                    let opp = 1 - player;
                    for h in 0..self.combos[opp].len() {
                        node_val[opp][h] += v[opp][h];
                    }
                }
                // CFR+ : regrets floored at zero, and the average strategy
                // weighted linearly by iteration. Both are what production
                // solvers use; vanilla CFR needs an order of magnitude more
                // iterations to reach the same exploitability.
                let w = self.iterations as f64 + 1.0;
                for h in 0..n {
                    let base = h * n_actions;
                    for a in 0..n_actions {
                        let r = self.regrets[node][base + a] + action_val[a][h]
                            - node_val[player][h];
                        self.regrets[node][base + a] = if r > 0.0 { r } else { 0.0 };
                        self.strat_sum[node][base + a] += w * reach[player][h] * strat[base + a];
                    }
                }
                node_val
            }
        }
    }

    pub fn run(&mut self, iters: u32) {
        let r = [
            vec![1.0; self.combos[0].len()],
            vec![1.0; self.combos[1].len()],
        ];
        for _ in 0..iters {
            self.cfr(0, &r);
            self.iterations += 1;
        }
    }

    fn average_strategy(&self, node: usize, player: usize, n_actions: usize) -> Vec<f64> {
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

    fn br(&self, node: usize, reach: &[Vec<f64>; 2], br_player: usize) -> [Vec<f64>; 2] {
        match self.nodes[node].clone() {
            SNode::Showdown { .. } | SNode::Fold { .. } => self.terminal(node, reach),
            SNode::Chance { first_child, cards } => {
                let p = 1.0 / cards.len() as f64;
                let mut out = [
                    vec![0.0; self.combos[0].len()],
                    vec![0.0; self.combos[1].len()],
                ];
                for (i, &c) in cards.iter().enumerate() {
                    let mut sub = [reach[0].clone(), reach[1].clone()];
                    for pl in 0..2 {
                        for (h, cc) in self.combos[pl].iter().enumerate() {
                            if cc[0] == c || cc[1] == c {
                                sub[pl][h] = 0.0;
                            } else {
                                sub[pl][h] *= p;
                            }
                        }
                    }
                    let v = self.br(self.children[first_child + i], &sub, br_player);
                    for pl in 0..2 {
                        for (h, cc) in self.combos[pl].iter().enumerate() {
                            if cc[0] != c && cc[1] != c {
                                out[pl][h] += v[pl][h];
                            }
                        }
                    }
                }
                out
            }
            SNode::Decision { player, first_child, n_actions } => {
                let n = self.combos[player].len();
                let strat = self.average_strategy(node, player, n_actions);
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
                    own[h] = if player == br_player {
                        vals.iter().map(|v| v[h]).fold(f64::NEG_INFINITY, f64::max)
                    } else {
                        (0..n_actions).map(|a| strat[h * n_actions + a] * vals[a][h]).sum()
                    };
                }
                let mut out = [
                    vec![0.0; self.combos[0].len()],
                    vec![0.0; self.combos[1].len()],
                ];
                out[player] = own;
                out[1 - player] = opp_acc;
                out
            }
        }
    }

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

    /// Chips per hand gained by deviating optimally from the average strategy.
    pub fn exploitability(&self) -> f64 {
        (self.value(0, 0) - self.value(0, 2)) + (self.value(1, 1) - self.value(1, 2))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::equity::parse_range;
    use crate::eval::parse_cards;

    fn cfg(buckets: Option<usize>) -> BetConfig {
        BetConfig {
            pot: 20.0,
            bet_frac: 0.7,
            allow_raise: false,
            runout_buckets: buckets,
        }
    }

    #[test]
    fn turn_solve_converges() {
        let board = parse_cards("2c7d9hJs");
        let r = parse_range("AA,KK,QQ,JJ,TT,99,AKs,AQs,KQs,AKo");
        let mut g = Game::build(&board, r.clone(), r, cfg(Some(6)));
        g.run(20);
        let early = g.exploitability();
        g.run(600);
        let late = g.exploitability();
        assert!(late < early, "exploitability should fall: {early} -> {late}");
        // Tight on purpose. Combos blocked by a dealt runout card used to leak
        // their meaningless subtree values up through the chance node, which
        // put a floor under best-response and stalled this around 4% of pot
        // while still looking like it was "converging".
        assert!(late < 0.005 * 20.0, "plateaued at {late} chips exploitable");
    }

    #[test]
    fn chance_nodes_deal_every_remaining_card() {
        let board = parse_cards("2c7d9hJs");
        let r = parse_range("AA,KK");
        let g = Game::build(&board, r.clone(), r, cfg(None));
        // The turn round ends in 3 continuations (check-check, bet-call,
        // check-bet-call); each deals one of 48 river cards; each river round
        // then has its own 3 showdown continuations. This 3x-per-street
        // fan-out on top of the card fan-out is what makes flop solves
        // expensive, so pin it.
        assert_eq!(g.n_showdowns(), 3 * 48 * 3);
    }

    #[test]
    fn bucketing_shrinks_the_tree_not_the_answer() {
        let board = parse_cards("2c7d9hJs");
        let r = parse_range("AA,KK,QQ,JJ,TT,99,AKs,AQs,KQs,AKo");
        let full = Game::build(&board, r.clone(), r.clone(), cfg(None));
        let bucketed = Game::build(&board, r.clone(), r, cfg(Some(8)));
        assert!(bucketed.strategy_slots() < full.strategy_slots() / 4);
    }
}
