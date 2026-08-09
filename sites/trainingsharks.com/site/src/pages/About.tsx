import { usePageMeta } from "../lib/meta";

export default function About() {
  usePageMeta(
    "About — TrainingSharks",
    "Why this trainer computes every answer instead of shipping charts, and what it deliberately does not do.",
    "/about"
  );
  return (
    <main className="page container container--narrow">
      <div className="page-head">
        <div className="page-head__text">
          <div className="eyebrow">// what this is</div>
          <h1>About</h1>
          <p className="page__lede">
            A free poker trainer for people who would rather understand a decision than memorise it.
          </p>
        </div>
      </div>

      <div className="prose">
        <p>
          Most poker study tools fall into two camps. Chart sites hand you a grid to memorise and
          never explain what happens when the spot is not on the grid. Solvers are magnificent,
          expensive, and built for professionals who already know what they are looking at.
        </p>
        <p>
          This sits in the gap. Every question it asks has an answer it can compute from first
          principles, in your browser, in milliseconds — and it shows you the working. The point is
          not to tell you what to do. It is to make the maths concrete enough that you stop needing
          to be told.
        </p>

        <h2>What it does not do</h2>
        <ul>
          <li>
            <strong>No real money, ever.</strong> There is no wagering here, no cashier, and no
            links to poker rooms. This is a study tool.
          </li>
          <li>
            <strong>No claimed GTO solutions.</strong> The opponents play stated, deliberately
            flawed ranges. Where the trainer is making an assumption, it prints it.
          </li>
          <li>
            <strong>No account required.</strong> Your session lives in your own browser.
          </li>
        </ul>

        <h2>The engine</h2>
        <p>
          Rust compiled to WebAssembly, roughly 75 KB, no dependencies. It evaluates hands from
          rank and suit histograms rather than shipping a giant lookup table, which is what keeps it
          small enough to send to a browser. Correctness was established by fuzzing it against a
          separately written brute-force evaluator across 400,000 hands — including the shared-board
          cases that produce ties, which is where evaluators usually go wrong — with zero
          disagreements.
        </p>

        <h2>A word about gambling</h2>
        <p>
          Poker is a game of skill played for money, and better decisions genuinely do make money
          over a long enough run. That does not make it safe. Variance is brutal, the run is longer
          than almost anyone expects, and no amount of study turns a losing bankroll into a
          guaranteed income. If the game has stopped being a game,{" "}
          <a href="https://www.begambleaware.org" target="_blank" rel="noopener">
            BeGambleAware
          </a>{" "}
          is a good place to start.
        </p>
      </div>
    </main>
  );
}
