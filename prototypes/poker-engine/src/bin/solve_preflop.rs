//! Solves heads-up push/fold at every stack depth we train and writes the table
//! the site ships. Run from the poker-engine dir:
//!   cargo run --release --bin solve_preflop -- <out.json>
use poker_engine::preflop::*;
use std::io::Write;

fn main() {
    let out = std::env::args().nth(1).unwrap_or_else(|| "pushfold.json".into());
    let iters: u32 = std::env::var("EQ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(60_000);
    let canon = all_canon();
    eprintln!("building 169x169 all-in equity matrix ({iters} runouts/matchup)...");
    let m = EquityMatrix::compute(&canon, iters, true);

    let depths: Vec<f64> = (2..=25).map(|x| x as f64).collect();
    let combos: Vec<usize> = canon.iter().map(|c| c.combos().len()).collect();
    let total_combos: f64 = combos.iter().sum::<usize>() as f64;

    let mut json = String::from("{\n  \"generated_by\": \"poker-engine solve_preflop\",\n");
    json.push_str(&format!("  \"equity_iters_per_matchup\": {iters},\n"));
    json.push_str("  \"hands\": [");
    json.push_str(&canon.iter().map(|c| format!("\"{}\"", c.label())).collect::<Vec<_>>().join(","));
    json.push_str("],\n  \"depths\": {\n");

    println!("{:>6} {:>10} {:>10}", "stack", "shove%", "call%");
    let mut rows = Vec::new();
    for (di, d) in depths.iter().enumerate() {
        let pf = solve_push_fold(&m, *d);
        let shove_pct: f64 = (0..N_CANON).map(|i| pf.push_freq[i] * combos[i] as f64).sum::<f64>() / total_combos * 100.0;
        let call_pct: f64 = (0..N_CANON).map(|i| pf.call_freq[i] * combos[i] as f64).sum::<f64>() / total_combos * 100.0;
        println!("{:>5}bb {:>9.1}% {:>9.1}%", d, shove_pct, call_pct);

        let f = |v: &Vec<f64>| v.iter().map(|x| format!("{:.3}", x)).collect::<Vec<_>>().join(",");
        let e = |v: &Vec<f64>| v.iter().map(|x| format!("{:.3}", x)).collect::<Vec<_>>().join(",");
        rows.push(format!(
            "    \"{}\": {{\"shove_pct\":{:.1},\"call_pct\":{:.1},\"push\":[{}],\"call\":[{}],\"push_ev\":[{}],\"call_ev\":[{}]}}",
            d, shove_pct, call_pct, f(&pf.push_freq), f(&pf.call_freq), e(&pf.push_ev), e(&pf.call_ev)
        ));
        let _ = di;
    }
    json.push_str(&rows.join(",\n"));
    json.push_str("\n  }\n}\n");

    let mut file = std::fs::File::create(&out).expect("create output");
    file.write_all(json.as_bytes()).expect("write");
    eprintln!("wrote {out} ({} KB)", json.len() / 1024);
}
