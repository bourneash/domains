import { Link } from "react-router-dom";
import { usePageMeta } from "../lib/meta";

export default function Help() {
  usePageMeta(
    "How it works — TrainingSharks",
    "What the drills ask, how answers are graded in chips, what the coach overlay shows, and how the leak report ranks your mistakes.",
    "/help"
  );
  return (
    <main className="page container container--narrow">
      <div className="page-head">
        <div className="page-head__text">
          <div className="eyebrow">// the manual</div>
          <h1>How it works</h1>
          <p className="page__lede">
            Three screens, one idea: every answer is computed, and every mistake gets a price.
          </p>
        </div>
      </div>

      <div className="prose">
        <h2>Drill</h2>
        <p>
          You get a board, a hand, and an opponent whose betting range is stated on screen. Two
          question types:
        </p>
        <ul>
          <li>
            <strong>Call or fold.</strong> The opponent bets. You are told the pot, the bet, and the
            equity you need to break even. Choose. The engine then computes your real equity against
            their range and tells you exactly what your choice was worth — right answers score zero,
            wrong ones are charged the expected value you gave up.
          </li>
          <li>
            <strong>Read the equity.</strong> Same spot, harder question: estimate your equity with
            the slider. Within seven points counts as a good read. Being wrong here costs you money
            indirectly, so the miss is priced as the bad call or fold it would have caused.
          </li>
        </ul>

        <h2>Play</h2>
        <p>
          Heads-up hands against one of the opponents, four streets, simplified betting — check,
          bet, call, fold. The coach rail shows your live equity against their range as the hand
          develops. Turn it off, play blind, and switch it back on when you want to check yourself.
        </p>
        <p>
          These opponents are not solvers, and the trainer never pretends otherwise. Each one is
          built around a specific, learnable mistake. Beating them teaches you to spot that mistake
          in a real person.
        </p>

        <h2>Leaks</h2>
        <p>
          Every graded answer is logged. The Leaks screen ranks your mistakes by total cost in big
          blinds, not by how often you make them — because a rare expensive error beats a frequent
          cheap one every time. Fix the top line first.
        </p>
        <p>
          Your session lives in your browser's local storage. Nothing is uploaded, and clearing
          site data resets it.
        </p>

        <h2>What the numbers mean</h2>
        <ul>
          <li>
            <strong>Equity</strong> — how often you win the pot, counting ties as half, against
            every combination in the opponent's stated range.
          </li>
          <li>
            <strong>Pot odds</strong> — the equity you need for a call to break even:
            bet ÷ (pot + 2 × bet).
          </li>
          <li>
            <strong>EV</strong> — what a decision is worth in big blinds. Folding is always exactly
            zero, which is what makes it the honest baseline.
          </li>
        </ul>

        <h2>Where the answers come from</h2>
        <p>
          A Rust engine compiled to WebAssembly, running in your browser. It samples 40,000 runouts
          per drill question. It was verified by fuzzing against an independently written
          brute-force evaluator over 400,000 hands with no disagreements, and it reproduces the
          textbook equities exactly.
        </p>
        <p>
          One honest limitation: the opponents' ranges are stated assumptions, not solver output.
          They are shown to you precisely so you can disagree with them. What the engine guarantees
          is that, given the range on screen, the equity and EV are right.
        </p>

        <p style={{ marginTop: 28 }}>
          <Link className="btn btn--primary" to="/train">
            Start training →
          </Link>
        </p>
      </div>
    </main>
  );
}
