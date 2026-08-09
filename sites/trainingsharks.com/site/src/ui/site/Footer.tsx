import { Link } from "react-router-dom";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <div>
          <div className="site-footer__brand">TrainingSharks</div>
          <p className="site-footer__blurb">
            A free poker trainer that computes every answer instead of looking it up. Play money
            only — nothing here is a real-money game, and no wagering happens on this site.
          </p>
        </div>
        <nav className="site-footer__links">
          <Link to="/train">Trainer</Link>
          <Link to="/help">How it works</Link>
          <Link to="/opponents">Opponents</Link>
          <Link to="/about">About</Link>
        </nav>
        <nav className="site-footer__links">
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
          <Link to="/contact">Contact</Link>
          <a href="https://0xroulette.com" target="_blank" rel="noopener">
            0xRoulette ↗
          </a>
        </nav>
      </div>
      <div className="container site-footer__legal">
        © {new Date().getFullYear()} TrainingSharks · Built for players who want the maths, not the
        mysticism. Gambling can be harmful — if it has stopped being a game, talk to someone at{" "}
        <a href="https://www.begambleaware.org" target="_blank" rel="noopener">
          BeGambleAware
        </a>
        .
      </div>
    </footer>
  );
}
