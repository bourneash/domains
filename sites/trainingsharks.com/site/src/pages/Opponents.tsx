import { Link } from "react-router-dom";
import { usePageMeta } from "../lib/meta";
import { ARCHETYPES } from "../lib/ranges";

export default function Opponents() {
  usePageMeta(
    "Opponents — TrainingSharks",
    "The four archetypes you train against, the range each one plays, and the specific mistake each is built to make.",
    "/opponents"
  );
  return (
    <main className="page container container--narrow">
      <div className="page-head">
        <div className="page-head__text">
          <div className="eyebrow">// the table</div>
          <h1>Opponents</h1>
          <p className="page__lede">
            Four players, each built around one exploitable habit. Their ranges are printed here in
            full — you should be able to check every answer the trainer gives you.
          </p>
        </div>
      </div>

      {ARCHETYPES.map((a) => (
        <section key={a.id} className="card" style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
            <svg viewBox="0 0 100 100" width="30" height="30" aria-hidden="true">
              <path
                d="M50 10 C 62 34, 80 62, 92 82 C 70 76, 44 76, 10 88 C 30 66, 44 38, 50 10 Z"
                fill={a.accent}
              />
            </svg>
            <div>
              <h2 style={{ margin: 0, fontSize: 18, color: "var(--text-bright)" }}>{a.name}</h2>
              <div style={{ color: "var(--muted)", fontSize: 12.5 }}>{a.tagline}</div>
            </div>
          </div>
          <p style={{ lineHeight: 1.7, marginBottom: 12 }}>{a.reads}</p>
          <div className="eyebrow" style={{ marginBottom: 6 }}>// betting range</div>
          <code
            style={{
              display: "block",
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              color: "var(--muted-2)",
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "10px 12px",
              wordBreak: "break-word",
              lineHeight: 1.7
            }}
          >
            {a.range}
          </code>
        </section>
      ))}

      <div className="prose">
        <p style={{ color: "var(--muted)" }}>
          These ranges are stated assumptions chosen to make each archetype's mistake clear and
          learnable. They are not solver output and the trainer never claims they are. Everything
          computed from them — equity, pot odds, expected value — is exact.
        </p>
        <p>
          <Link className="btn btn--primary" to="/train">
            Go beat them →
          </Link>
        </p>
      </div>
    </main>
  );
}
