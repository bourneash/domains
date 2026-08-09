import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CardRow, CardView } from "./CardView";
import {
  botAction,
  callEV,
  gradeDecision,
  gradeEquity,
  makeDrill,
  newHand,
  requiredEquity,
  visibleBoard,
  type Drill,
  type DrillKind,
  type PlayState,
  type Verdict
} from "./logic";
import { ARCHETYPES, liveCombos, parseRange, type Archetype } from "../lib/ranges";
import { HAND_CATEGORIES, cardName, handLabel, rng } from "../lib/cards";
import { category, equity, loadEngine, strength } from "../lib/engine";
import "./trainer.css";

type Mode = "drill" | "play" | "leaks";

interface Leak {
  count: number;
  cost: number;
}

interface Session {
  answered: number;
  correct: number;
  evLost: number;
  streak: number;
  bestStreak: number;
  leaks: Record<string, Leak>;
}

const EMPTY: Session = {
  answered: 0,
  correct: 0,
  evLost: 0,
  streak: 0,
  bestStreak: 0,
  leaks: {}
};

const SESSION_KEY = "ts_session_v1";

function loadSession(): Session {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    /* corrupt or unavailable storage is not worth failing the app over */
  }
  return EMPTY;
}

function Fin({ color, size = 30 }: { color: string; size?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
      <path d="M50 10 C 62 34, 80 62, 92 82 C 70 76, 44 76, 10 88 C 30 66, 44 38, 50 10 Z" fill={color} opacity="0.9" />
    </svg>
  );
}

export default function Trainer() {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("drill");
  const [villain, setVillain] = useState<Archetype>(ARCHETYPES[0]);
  const [session, setSession] = useState<Session>(loadSession);

  useEffect(() => {
    loadEngine()
      .then(() => setReady(true))
      .catch((e) => setLoadError(String(e)));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      /* private mode — session simply won't persist */
    }
  }, [session]);

  const record = useCallback((v: Verdict) => {
    setSession((s) => {
      const leaks = { ...s.leaks };
      if (v.leak) {
        const prev = leaks[v.leak] ?? { count: 0, cost: 0 };
        leaks[v.leak] = { count: prev.count + 1, cost: prev.cost + v.evLost };
      }
      const streak = v.correct ? s.streak + 1 : 0;
      return {
        answered: s.answered + 1,
        correct: s.correct + (v.correct ? 1 : 0),
        evLost: s.evLost + v.evLost,
        streak,
        bestStreak: Math.max(s.bestStreak, streak),
        leaks
      };
    });
  }, []);

  if (loadError) {
    return (
      <div className="trainer" data-theme="dark">
        <div className="felt">
          <div className="empty-note" style={{ maxWidth: 520 }}>
            The solver engine failed to load: {loadError}
            <br />
            <br />
            Nothing here works without it, so rather than show you made-up numbers the trainer
            stops. Reload, or let us know at contact@trainingsharks.com.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="trainer" data-theme="dark">
      <div className="trainer__bar">
        <Link
          to="/"
          className="trainer__mode"
          style={{ textDecoration: "none", paddingLeft: 0 }}
          title="Back to TrainingSharks"
        >
          ← Site
        </Link>
        <div className="trainer__modes">
          {(["drill", "play", "leaks"] as Mode[]).map((m) => (
            <button
              key={m}
              className={mode === m ? "trainer__mode is-active" : "trainer__mode"}
              onClick={() => setMode(m)}
            >
              {m === "drill" ? "Drill" : m === "play" ? "Play" : "Leaks"}
            </button>
          ))}
        </div>

        <label className="trainer__stat">
          Opponent
          <select
            value={villain.id}
            onChange={(e) =>
              setVillain(ARCHETYPES.find((a) => a.id === e.target.value) ?? ARCHETYPES[0])
            }
            style={{
              background: "var(--panel)",
              color: "var(--text-bright)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "4px 8px",
              fontFamily: "var(--font-mono)",
              fontSize: 11
            }}
          >
            {ARCHETYPES.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <div className="trainer__spacer" />
        <div className="trainer__stat">
          Accuracy
          <b>
            {session.answered ? Math.round((session.correct / session.answered) * 100) : 0}%
          </b>
        </div>
        <div className="trainer__stat">
          Streak <b>{session.streak}</b>
        </div>
        <div className="trainer__stat">
          EV lost <b style={{ color: "var(--neg)" }}>{session.evLost.toFixed(1)} bb</b>
        </div>
      </div>

      {!ready ? (
        <div className="felt">
          <div className="felt__label">Loading solver engine…</div>
        </div>
      ) : mode === "drill" ? (
        <DrillMode villain={villain} onGraded={record} session={session} />
      ) : mode === "play" ? (
        <PlayMode villain={villain} />
      ) : (
        <Leaks session={session} onReset={() => setSession(EMPTY)} />
      )}
    </div>
  );
}

// --- Drill -----------------------------------------------------------------

function DrillMode({
  villain,
  onGraded,
  session
}: {
  villain: Archetype;
  onGraded: (v: Verdict) => void;
  session: Session;
}) {
  const [kind, setKind] = useState<DrillKind>("decision");
  const [drill, setDrill] = useState<Drill | null>(null);
  const [guess, setGuess] = useState(50);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const seedRef = useRef(Math.floor(Math.random() * 1e9));

  const next = useCallback(() => {
    seedRef.current = (seedRef.current + 0x9e3779b1) >>> 0;
    setDrill(makeDrill(kind, villain, seedRef.current));
    setVerdict(null);
    setGuess(50);
  }, [kind, villain]);

  useEffect(() => {
    next();
  }, [next]);

  const answer = (v: Verdict) => {
    setVerdict(v);
    onGraded(v);
  };

  if (!drill) return <div className="felt"><div className="felt__label">Dealing…</div></div>;

  const need = requiredEquity(drill.pot, drill.bet);
  const madeHand = HAND_CATEGORIES[category([...drill.hero, ...drill.board])];

  return (
    <div className="trainer__body">
      <div className="felt">
        <div className="trainer__modes" style={{ marginBottom: 4 }}>
          {(["decision", "equity"] as DrillKind[]).map((k) => (
            <button
              key={k}
              className={kind === k ? "trainer__mode is-active" : "trainer__mode"}
              onClick={() => setKind(k)}
            >
              {k === "decision" ? "Call or fold" : "Read the equity"}
            </button>
          ))}
        </div>

        <div className="felt__label">
          {drill.street} · board
        </div>
        <CardRow cards={drill.board} size="lg" placeholders={5} />

        <div className="pot">
          {drill.pot} bb<span>pot</span>
        </div>

        <div className="felt__label">your hand — {handLabel(...drill.hero)} · {madeHand}</div>
        <CardRow cards={drill.hero} size="lg" />

        <div className="ask">
          {kind === "decision" ? (
            <>
              <div className="ask__q">
                <b>{villain.name}</b> bets <b>{drill.bet} bb</b> into <b>{drill.pot} bb</b>. You need{" "}
                {(need * 100).toFixed(1)}% equity to break even. Call or fold?
              </div>
              <div className="ask__actions">
                <button
                  className="tbtn tbtn--pos"
                  disabled={!!verdict}
                  onClick={() => answer(gradeDecision(drill, "call"))}
                >
                  Call {drill.bet} bb
                </button>
                <button
                  className="tbtn tbtn--neg"
                  disabled={!!verdict}
                  onClick={() => answer(gradeDecision(drill, "fold"))}
                >
                  Fold
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="ask__q">
                How much equity do you have against <b>{villain.name}</b>'s range of{" "}
                {drill.range.length} combos?
              </div>
              <div className="slider-row">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={0.5}
                  value={guess}
                  disabled={!!verdict}
                  onChange={(e) => setGuess(Number(e.target.value))}
                />
                <output>{guess.toFixed(1)}%</output>
              </div>
              <div className="ask__actions" style={{ marginTop: 12 }}>
                <button
                  className="tbtn tbtn--primary"
                  disabled={!!verdict}
                  onClick={() => answer(gradeEquity(drill, guess))}
                >
                  Lock it in
                </button>
              </div>
            </>
          )}

          {verdict && (
            <>
              <div className={verdict.correct ? "verdict verdict--good" : "verdict verdict--bad"}>
                <div className="verdict__head">{verdict.headline}</div>
                <div className="verdict__detail">{verdict.detail}</div>
                <div className="verdict__detail" style={{ marginTop: 8 }}>
                  {kind === "decision"
                    ? `EV of calling: ${callEV(drill.equity, drill.pot, drill.bet).toFixed(2)} bb. Folding is always 0.`
                    : `Break-even against the ${drill.bet} bb bet would be ${(need * 100).toFixed(1)}%.`}
                </div>
              </div>
              <div className="ask__actions" style={{ marginTop: 14 }}>
                <button className="tbtn tbtn--primary" onClick={next} autoFocus>
                  Next spot →
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <aside className="coach">
        <div className="villain">
          <Fin color={villain.accent} />
          <div>
            <div className="villain__name">{villain.name}</div>
            <div className="villain__tag">{villain.tagline}</div>
          </div>
        </div>

        <div className="coach__block">
          <h3>How to beat them</h3>
          <p>{villain.reads}</p>
        </div>

        <div className="coach__block">
          <h3>This spot</h3>
          <dl>
            <div className="kv">
              <dt>Street</dt>
              <dd>{drill.street}</dd>
            </div>
            <div className="kv">
              <dt>Your hand</dt>
              <dd>{drill.hero.map(cardName).join(" ")}</dd>
            </div>
            <div className="kv">
              <dt>Made hand</dt>
              <dd>{madeHand}</dd>
            </div>
            <div className="kv">
              <dt>Villain combos</dt>
              <dd>{drill.range.length}</dd>
            </div>
            <div className="kv">
              <dt>Pot odds</dt>
              <dd>{(need * 100).toFixed(1)}%</dd>
            </div>
            {verdict && (
              <div className="kv">
                <dt>Your equity</dt>
                <dd style={{ color: "var(--accent)" }}>{(drill.equity * 100).toFixed(1)}%</dd>
              </div>
            )}
          </dl>
          {verdict && (
            <div className="meter" style={{ marginTop: 8 }}>
              <div className="meter__fill" style={{ width: `${drill.equity * 100}%` }} />
            </div>
          )}
        </div>

        <div className="coach__block">
          <h3>Session</h3>
          <dl>
            <div className="kv">
              <dt>Spots</dt>
              <dd>{session.answered}</dd>
            </div>
            <div className="kv">
              <dt>Best streak</dt>
              <dd>{session.bestStreak}</dd>
            </div>
          </dl>
        </div>

        <div className="coach__block">
          <h3>Why you can trust the answer</h3>
          <p>
            Equity is computed in-browser by a Rust engine compiled to WebAssembly, sampling 40,000
            runouts against the exact combos listed above. Nothing is looked up from a chart. Deal
            the same seed and you get the same number, every time.
          </p>
        </div>
      </aside>
    </div>
  );
}

// --- Play ------------------------------------------------------------------

const BET_FRACTION = 0.66;

function PlayMode({ villain }: { villain: Archetype }) {
  const [stacks, setStacks] = useState({ hero: 100, bot: 100 });
  const [state, setState] = useState<PlayState | null>(null);
  const [facing, setFacing] = useState(0);
  const [showCoach, setShowCoach] = useState(true);
  const seedRef = useRef(Math.floor(Math.random() * 1e9));

  const deal = useCallback(() => {
    seedRef.current = (seedRef.current + 0x9e3779b1) >>> 0;
    setState(newHand(villain, seedRef.current, 100, 100));
    setFacing(0);
  }, [villain]);

  useEffect(() => {
    deal();
  }, [deal]);

  const liveEquity = useMemo(() => {
    if (!state || state.result) return null;
    const board = visibleBoard(state);
    const range = liveCombos(parseRange(villain.range), [...state.hero, ...board]);
    if (!range.length) return null;
    return equity(state.hero, board, range, 12000, state.seed + board.length);
  }, [state, villain]);

  if (!state) return <div className="felt"><div className="felt__label">Shuffling…</div></div>;

  const board = visibleBoard(state);
  const rand = rng(state.seed + state.pot * 7 + board.length);

  const finish = (s: PlayState, winner: "hero" | "bot" | "chop", reason: string, delta: number) => {
    setStacks((k) => ({ hero: k.hero + delta, bot: k.bot - delta }));
    return { ...s, result: { winner, reason, delta }, stage: "showdown" as const };
  };

  const advance = (s: PlayState, log: string[]): PlayState => {
    const order: PlayState["stage"][] = ["preflop", "flop", "turn", "river", "showdown"];
    const nextStage = order[order.indexOf(s.stage) + 1];
    if (nextStage !== "showdown") {
      return { ...s, stage: nextStage, log: [...log, `--- ${nextStage} ---`] };
    }
    const hs = strength([...s.hero, ...s.board]);
    const bs = strength([...s.bot, ...s.board]);
    const half = s.pot / 2;
    if (hs > bs) return finish({ ...s, log }, "hero", "You win at showdown.", half);
    if (bs > hs) return finish({ ...s, log }, "bot", `${villain.name} wins at showdown.`, -half);
    return finish({ ...s, log }, "chop", "Split pot.", 0);
  };

  const botRespond = (s: PlayState, heroBet: number, log: string[]): PlayState => {
    const act = botAction(s, villain, heroBet, rand);
    if (heroBet > 0) {
      if (act === "fold") {
        return finish(
          { ...s, log: [...log, `${villain.name} folds.`] },
          "hero",
          `${villain.name} folded.`,
          s.pot / 2
        );
      }
      const pot = s.pot + heroBet;
      return advance({ ...s, pot }, [...log, `${villain.name} calls ${heroBet.toFixed(1)} bb.`]);
    }
    if (act === "bet") {
      const bet = Math.max(1, Math.round(s.pot * BET_FRACTION));
      setFacing(bet);
      return { ...s, log: [...log, `${villain.name} bets ${bet} bb.`] };
    }
    return advance(s, [...log, `${villain.name} checks.`]);
  };

  const onCheck = () => setState((s) => (s ? botRespond(s, 0, [...s.log, "You check."]) : s));

  const onBet = () =>
    setState((s) => {
      if (!s) return s;
      const bet = Math.max(1, Math.round(s.pot * BET_FRACTION));
      return botRespond({ ...s, pot: s.pot + bet }, bet, [...s.log, `You bet ${bet} bb.`]);
    });

  const onCall = () =>
    setState((s) => {
      if (!s) return s;
      const pot = s.pot + facing;
      setFacing(0);
      return advance({ ...s, pot }, [...s.log, `You call ${facing} bb.`]);
    });

  const onFold = () =>
    setState((s) => {
      if (!s) return s;
      setFacing(0);
      return finish(
        { ...s, log: [...s.log, "You fold."] },
        "bot",
        `You folded to ${villain.name}.`,
        -s.pot / 2
      );
    });

  const done = !!state.result;

  return (
    <div className="trainer__body">
      <div className="felt">
        <div className="felt__label">
          {villain.name} · {done ? "cards up" : "holding"}
        </div>
        <div className="pcard-row">
          {done ? (
            state.bot.map((c, i) => <CardView key={i} card={c} size="md" />)
          ) : (
            <>
              <CardView facedown size="md" />
              <CardView facedown size="md" />
            </>
          )}
        </div>

        <CardRow cards={board} size="lg" placeholders={5} />
        <div className="pot">
          {state.pot.toFixed(1)} bb<span>pot · {state.stage}</span>
        </div>

        <div className="felt__label">
          you — {handLabel(...state.hero)}
          {board.length >= 3 && ` · ${HAND_CATEGORIES[category([...state.hero, ...board])]}`}
        </div>
        <CardRow cards={state.hero} size="lg" />

        <div className="ask">
          {done ? (
            <>
              <div className="ask__q">
                <b>{state.result!.reason}</b>{" "}
                {state.result!.delta !== 0 &&
                  `(${state.result!.delta > 0 ? "+" : ""}${state.result!.delta.toFixed(1)} bb)`}
              </div>
              <div className="ask__actions">
                <button className="tbtn tbtn--primary" onClick={deal} autoFocus>
                  Deal next hand →
                </button>
              </div>
            </>
          ) : facing > 0 ? (
            <>
              <div className="ask__q">
                {villain.name} bets <b>{facing} bb</b>. You need{" "}
                {(requiredEquity(state.pot - facing, facing) * 100).toFixed(1)}% to call profitably.
              </div>
              <div className="ask__actions">
                <button className="tbtn tbtn--pos" onClick={onCall}>
                  Call {facing} bb
                </button>
                <button className="tbtn tbtn--neg" onClick={onFold}>
                  Fold
                </button>
              </div>
            </>
          ) : (
            <div className="ask__actions">
              <button className="tbtn" onClick={onCheck}>
                Check
              </button>
              <button className="tbtn tbtn--primary" onClick={onBet}>
                Bet {Math.max(1, Math.round(state.pot * BET_FRACTION))} bb
              </button>
            </div>
          )}
        </div>
      </div>

      <aside className="coach">
        <div className="villain">
          <Fin color={villain.accent} />
          <div>
            <div className="villain__name">{villain.name}</div>
            <div className="villain__tag">{villain.tagline}</div>
          </div>
        </div>

        <div className="coach__block">
          <h3>Bankroll</h3>
          <dl>
            <div className="kv">
              <dt>You</dt>
              <dd style={{ color: stacks.hero >= 100 ? "var(--pos)" : "var(--neg)" }}>
                {stacks.hero.toFixed(1)} bb
              </dd>
            </div>
            <div className="kv">
              <dt>{villain.name}</dt>
              <dd>{stacks.bot.toFixed(1)} bb</dd>
            </div>
          </dl>
        </div>

        <div className="coach__block">
          <h3>
            Coach overlay{" "}
            <button
              className="trainer__mode"
              style={{ padding: "2px 8px", float: "right" }}
              onClick={() => setShowCoach((v) => !v)}
            >
              {showCoach ? "hide" : "show"}
            </button>
          </h3>
          {showCoach ? (
            liveEquity === null ? (
              <p>Equity appears once the hand is live.</p>
            ) : (
              <>
                <p>
                  Against {villain.name}'s assumed range you have{" "}
                  <b style={{ color: "var(--accent)" }}>{(liveEquity * 100).toFixed(1)}%</b> equity
                  right now.
                </p>
                <div className="meter" style={{ marginTop: 8 }}>
                  <div className="meter__fill" style={{ width: `${liveEquity * 100}%` }} />
                </div>
              </>
            )
          ) : (
            <p>Hidden — play blind, then turn it back on to check yourself.</p>
          )}
        </div>

        <div className="coach__block">
          <h3>How to beat them</h3>
          <p>{villain.reads}</p>
        </div>

        <div className="coach__block">
          <h3>Hand log</h3>
          <div className="log">
            {state.log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

// --- Leaks -----------------------------------------------------------------

function Leaks({ session, onReset }: { session: Session; onReset: () => void }) {
  const rows = Object.entries(session.leaks).sort((a, b) => b[1].cost - a[1].cost);
  return (
    <div className="felt" style={{ justifyContent: "flex-start" }}>
      <div className="ask" style={{ maxWidth: 620 }}>
        <div className="ask__q" style={{ marginBottom: 18 }}>
          Your leaks, most expensive first
        </div>

        {session.answered === 0 ? (
          <div className="empty-note">
            Nothing to report yet. Answer some spots in Drill and this fills in with the mistakes
            that actually cost you chips — ranked by how much.
          </div>
        ) : (
          <>
            <dl style={{ marginBottom: 18 }}>
              <div className="kv">
                <dt>Spots played</dt>
                <dd>{session.answered}</dd>
              </div>
              <div className="kv">
                <dt>Accuracy</dt>
                <dd>{Math.round((session.correct / session.answered) * 100)}%</dd>
              </div>
              <div className="kv">
                <dt>Total EV given up</dt>
                <dd style={{ color: "var(--neg)" }}>{session.evLost.toFixed(2)} bb</dd>
              </div>
              <div className="kv">
                <dt>Average per spot</dt>
                <dd>{(session.evLost / session.answered).toFixed(3)} bb</dd>
              </div>
              <div className="kv">
                <dt>Best streak</dt>
                <dd>{session.bestStreak}</dd>
              </div>
            </dl>

            {rows.length === 0 ? (
              <div className="empty-note">No mistakes recorded yet. Keep going.</div>
            ) : (
              rows.map(([name, leak]) => (
                <div className="leak-row" key={name}>
                  <span>
                    <b style={{ color: "var(--text-bright)" }}>{name}</b>
                    <span style={{ color: "var(--muted)" }}> · {leak.count}×</span>
                  </span>
                  <span className="leak-row__cost">−{leak.cost.toFixed(2)} bb</span>
                </div>
              ))
            )}
          </>
        )}

        <div className="ask__actions" style={{ marginTop: 20 }}>
          <button className="tbtn tbtn--neg" onClick={onReset}>
            Reset session
          </button>
        </div>
      </div>
    </div>
  );
}
