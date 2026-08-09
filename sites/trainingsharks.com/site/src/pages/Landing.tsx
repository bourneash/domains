import { Link } from "react-router-dom";
import { usePageMeta } from "../lib/meta";
import { ARCHETYPES } from "../lib/ranges";

const MODES = [
  {
    title: "Drill",
    tag: "repeat",
    body: "Spot after spot, graded the only way that matters: in chips. Call or fold against a stated range, or read your equity from the felt and find out how far off you were. Every answer is computed live — no charts, nothing memorised, nothing you can't check.",
    accent: "var(--accent)"
  },
  {
    title: "Play",
    tag: "exploit",
    body: "Sit down against a table of deliberately flawed opponents. The Nit folds too much. The Station never folds at all. Beating them is not about playing perfectly — it is about noticing what they do too often and charging them for it.",
    accent: "#f2555a"
  },
  {
    title: "Leaks",
    tag: "improve",
    body: "Every mistake gets logged with a price tag. Overfolding, overcalling, misreading equity — ranked by what each one actually costs you per hand. Fix the top line and you have found more money than any chart will ever give you.",
    accent: "var(--gold-bright)"
  }
];

export default function Landing() {
  usePageMeta(
    "TrainingSharks — a poker trainer that computes the answer",
    "Free browser poker trainer. Drill equity and pot-odds decisions graded in chips, play against deliberately exploitable opponents, and get a leak report that ranks your mistakes by what they cost.",
    "/"
  );

  return (
    <main style={{ flex: 1 }}>
      <section className="hero-wrap">
        <div className="hero-media__scrim" aria-hidden="true" />
        <div className="container hero">
          <div className="eyebrow">// the maths is not optional. it is the whole game.</div>
          <h1 className="hero__title">
            Everyone at the table
            <br />
            <span className="hero__title-line2">
              <span className="hl">is food.</span> <span style={{ color: "var(--accent)" }}>Be the shark.</span>
            </span>
          </h1>
          <p className="hero__sub">
            A free poker trainer that works out every answer in your browser instead of looking it
            up in a chart. Drill the decisions that actually cost money, play against opponents
            built to be beatable in specific ways, and get a leak report that tells you what your
            mistakes are worth in big blinds.
          </p>
          <div className="hero__cta">
            <Link className="btn btn--primary" to="/train">
              Start training — free
            </Link>
            <Link className="btn btn--ghost" to="/help">
              How it works
            </Link>
          </div>
          <p className="muted-note" style={{ marginTop: 18 }}>
            Play money only. No signup, no wagering, no real-money games — anywhere on this site.
          </p>

          <aside className="hero__demo" aria-hidden="true">
            <div className="hero__demo-label">// river · vs the nit · pot 24 bb</div>
            <div className="hero__demo-cards">
              {[
                ["K", "\u2660", "var(--suit-s)"],
                ["9", "\u2666", "var(--suit-d)"],
                ["7", "\u2663", "var(--suit-c)"],
                ["4", "\u2665", "var(--suit-h)"],
                ["2", "\u2660", "var(--suit-s)"]
              ].map(([r, g, c], i) => (
                <div className="hero__demo-card" key={i} style={{ color: c }}>
                  {r}
                  <small>{g}</small>
                </div>
              ))}
            </div>
            <div className="hero__demo-meter">
              <i style={{ width: "31%" }} />
            </div>
            <div className="hero__demo-row">
              <span>your equity</span>
              <span style={{ color: "var(--accent)" }}>31.4%</span>
            </div>
            <div className="hero__demo-row">
              <span>need to call</span>
              <span>40.0%</span>
            </div>
            <div className="hero__demo-verdict">Calling costs you 3.34 bb. Fold.</div>
          </aside>
        </div>
      </section>

      <section className="container" style={{ padding: "72px 0 24px" }}>
        <div className="eyebrow eyebrow--green">// three ways in</div>
        <div className="mode-grid">
          {MODES.map((m) => (
            <article className="mode" key={m.title}>
              <div className="mode__head">
                <h3 className="mode__title" style={{ color: m.accent }}>
                  {m.title}
                </h3>
                <span className="mode__tag">{m.tag}</span>
              </div>
              <p>{m.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="container" style={{ padding: "48px 0" }}>
        <div className="eyebrow eyebrow--green">// know your table</div>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, marginBottom: 10 }}>
          Four opponents. Four different mistakes to punish.
        </h2>
        <p className="page__lede" style={{ maxWidth: 720, marginBottom: 26 }}>
          Solvers teach you not to lose. That is a fine goal and a slow way to make money. At the
          stakes most people actually play, the profit comes from the person opposite doing one
          thing far too often — so that is what these opponents are built to do.
        </p>
        <div className="card-grid">
          {ARCHETYPES.map((a) => (
            <article className="card" key={a.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <svg viewBox="0 0 100 100" width="22" height="22" aria-hidden="true">
                  <path
                    d="M50 10 C 62 34, 80 62, 92 82 C 70 76, 44 76, 10 88 C 30 66, 44 38, 50 10 Z"
                    fill={a.accent}
                  />
                </svg>
                <strong style={{ color: "var(--text-bright)" }}>{a.name}</strong>
              </div>
              <p style={{ color: "var(--muted)", fontSize: 12.5, marginBottom: 8 }}>{a.tagline}</p>
              <p style={{ fontSize: 13, lineHeight: 1.65 }}>{a.reads}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="container container--narrow" style={{ padding: "24px 0 80px" }}>
        <div className="eyebrow eyebrow--green">// why you can trust the numbers</div>
        <div className="prose">
          <p>
            The engine underneath is written in Rust and compiled to WebAssembly — about 75 KB that
            runs entirely on your machine. It evaluates poker hands from scratch and samples tens of
            thousands of runouts per question, which takes a couple of milliseconds.
          </p>
          <p>
            It was checked the boring way: fuzzed against a deliberately naive reference
            implementation over 400,000 hands with zero disagreements, and confirmed to reproduce
            the equities every calculator agrees on — aces against kings comes back at 81.946%.
          </p>
          <p>
            Nothing in the trainer is a chart we typed in and hoped you would not check. If you
            disagree with an answer, the exact range it was computed against is on screen.
          </p>
          <p style={{ color: "var(--muted)" }}>
            Built by the same people as{" "}
            <a href="https://0xroulette.com" target="_blank" rel="noopener">
              0xRoulette
            </a>
            , where the same idea gets pointed at a game you genuinely cannot beat.
          </p>
        </div>
      </section>
    </main>
  );
}
