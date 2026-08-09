import { usePageMeta } from "../lib/meta";

export default function Terms() {
  usePageMeta(
    "Terms of use — TrainingSharks",
    "Play money only, no wagering, no guarantees about results.",
    "/terms"
  );
  return (
    <main className="page container container--narrow">
      <div className="page-head">
        <div className="page-head__text">
          <div className="eyebrow">// the honest bit</div>
          <h1>Terms of use</h1>
        </div>
      </div>

      <div className="prose">
        <h2>This is not a gambling site</h2>
        <p>
          TrainingSharks is a study tool. Everything on it is play money. There is no wagering, no
          deposit, no withdrawal, no prize, and nothing of value can be won or lost here.
        </p>

        <h2>No guarantee of results</h2>
        <p>
          Studying improves decisions. It does not guarantee profit. Poker involves substantial
          short-term variance, and a run of correct decisions can and regularly does lose money.
          Nothing here should be read as a promise that you will win, or as financial advice.
        </p>

        <h2>The maths is stated, the ranges are assumed</h2>
        <p>
          Equity and expected value are computed exactly against the range shown on screen. Those
          ranges are our stated assumptions about how a given opponent type plays — chosen to be
          instructive, not claimed to be optimal. We print them so you can judge them yourself.
        </p>

        <h2>Availability</h2>
        <p>
          Provided as-is, with no warranty, and no commitment that it will be available or unchanged
          tomorrow.
        </p>

        <h2>Age</h2>
        <p>
          Poker content is intended for adults. If gambling is illegal where you are, or you are
          under the legal age, this site is not for you.
        </p>
      </div>
    </main>
  );
}
