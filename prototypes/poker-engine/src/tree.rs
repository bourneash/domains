//! Preflop betting-tree sizing.
//!
//! The open product question this answers: can a full 6-max preflop strategy
//! ship inside the wasm payload, or does it need server lookups? Storage is
//! `decision_nodes * 169 canonical hands * actions * 1 byte` (frequencies
//! quantised to u8), so the whole thing rides on the node count.

#[derive(Clone, Copy, Debug)]
pub struct TreeConfig {
    pub players: u8,
    /// Distinct raise sizes offered at each decision (excluding all-in).
    pub raise_sizes: u8,
    /// Max raises in the round; the last one is treated as all-in.
    pub raise_cap: u8,
}

#[derive(Default, Debug, Clone, Copy)]
pub struct TreeStats {
    pub decision_nodes: u64,
    pub terminal_nodes: u64,
    /// Sum of legal actions over all decision nodes — this is what actually
    /// gets stored, since wide nodes cost more than narrow ones.
    pub action_slots: u64,
}

impl TreeStats {
    /// Bytes to store a strategy for every canonical preflop hand at every node.
    pub fn strategy_bytes(&self) -> u64 {
        self.action_slots * 169
    }
}

pub fn count_tree(cfg: TreeConfig) -> TreeStats {
    let mut st = TreeStats::default();
    let all_alive: u32 = (1 << cfg.players) - 1;
    // Preflop opens with the BB's blind as the standing bet, so the big blind
    // (last seat) has not yet acted even though it has money in.
    walk(cfg, all_alive, 0, 0, 0, &mut st);
    st
}

fn walk(cfg: TreeConfig, alive: u32, acted: u32, to_act: u8, raises: u8, st: &mut TreeStats) {
    if alive.count_ones() <= 1 {
        st.terminal_nodes += 1;
        return;
    }
    if acted & alive == alive {
        st.terminal_nodes += 1; // round closed, on to the flop
        return;
    }
    // Skip seats that already folded.
    let mut actor = to_act;
    let mut guard = 0;
    while alive & (1 << actor) == 0 {
        actor = (actor + 1) % cfg.players;
        guard += 1;
        if guard > cfg.players {
            st.terminal_nodes += 1;
            return;
        }
    }

    let can_raise = raises < cfg.raise_cap;
    let n_raise = if can_raise { cfg.raise_sizes as u64 } else { 0 };
    st.decision_nodes += 1;
    st.action_slots += 2 + n_raise; // fold + call + raise sizes

    let next = (actor + 1) % cfg.players;
    let bit = 1u32 << actor;

    // fold
    walk(cfg, alive & !bit, acted & !bit, next, raises, st);
    // call
    walk(cfg, alive, acted | bit, next, raises, st);
    // raises — sizes share a shape, so one recursion counted n_raise times
    if can_raise {
        let mut sub = TreeStats::default();
        walk(cfg, alive, bit, next, raises + 1, &mut sub);
        st.decision_nodes += sub.decision_nodes * n_raise;
        st.terminal_nodes += sub.terminal_nodes * n_raise;
        st.action_slots += sub.action_slots * n_raise;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heads_up_no_raises_is_tiny() {
        // 2 players, no raising allowed: SB folds or calls; if it calls, BB acts.
        let st = count_tree(TreeConfig {
            players: 2,
            raise_sizes: 0,
            raise_cap: 0,
        });
        assert_eq!(st.decision_nodes, 2);
    }

    #[test]
    fn more_players_and_sizes_grow_the_tree() {
        let small = count_tree(TreeConfig {
            players: 6,
            raise_sizes: 1,
            raise_cap: 2,
        });
        let big = count_tree(TreeConfig {
            players: 6,
            raise_sizes: 3,
            raise_cap: 4,
        });
        assert!(big.decision_nodes > small.decision_nodes * 10);
    }
}
