import { Link } from "react-router-dom";

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="TrainingSharks home">
      <svg viewBox="0 0 100 100" width="22" height="22" aria-hidden="true">
        <path
          d="M50 8 C 62 34, 80 62, 94 84 C 70 77, 44 77, 6 92 C 30 68, 44 38, 50 8 Z"
          fill="var(--accent)"
        />
      </svg>
      <span className="logo__hex">Training</span>
      <span>Sharks</span>
      <span className="logo__cursor" aria-hidden="true" />
    </Link>
  );
}
