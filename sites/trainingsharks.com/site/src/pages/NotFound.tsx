import { Link } from "react-router-dom";
import { usePageMeta } from "../lib/meta";

export default function NotFound() {
  usePageMeta("Not found — TrainingSharks", "That page does not exist.");
  return (
    <main className="page container container--narrow notfound">
      <div className="notfound__code">404</div>
      <h1>Folded.</h1>
      <p className="page__lede">
        There is nothing at this address. No shame in it — folding is the only decision that is
        always worth exactly zero.
      </p>
      <p>
        <Link className="btn btn--primary" to="/train">
          Back to the trainer →
        </Link>
      </p>
    </main>
  );
}
