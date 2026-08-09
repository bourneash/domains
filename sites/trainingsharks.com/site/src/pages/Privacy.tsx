import { usePageMeta } from "../lib/meta";

export default function Privacy() {
  usePageMeta(
    "Privacy — TrainingSharks",
    "What we store (almost nothing), what stays in your browser, and how analytics consent works.",
    "/privacy"
  );
  return (
    <main className="page container container--narrow">
      <div className="page-head">
        <div className="page-head__text">
          <div className="eyebrow">// the short version</div>
          <h1>Privacy</h1>
          <p className="page__lede">
            The trainer runs entirely in your browser. We do not have an account system, and there
            is nothing for you to log into.
          </p>
        </div>
      </div>

      <div className="prose">
        <h2>What stays on your device</h2>
        <p>
          Your session statistics — spots played, accuracy, streaks and your leak report — are kept
          in your browser's local storage and never sent anywhere. Clearing your site data deletes
          them permanently, and we cannot recover them because we never had them.
        </p>

        <h2>Analytics</h2>
        <p>
          If, and only if, you press Accept on the cookie notice, we load Google Analytics 4 to
          count page views. It is configured with IP anonymisation on, and Google Signals and ad
          personalisation both switched off. Press Decline and no analytics script is loaded at all
          — not a limited version, none.
        </p>
        <p>
          You can change your mind by clearing this site's data in your browser, which brings the
          notice back.
        </p>

        <h2>What we never collect</h2>
        <ul>
          <li>Names, emails or accounts — we do not have any.</li>
          <li>Your hands, answers, or results. They never leave your machine.</li>
          <li>Anything sold or shared with third parties.</li>
        </ul>

        <h2>Contact</h2>
        <p>
          Questions about any of this: <a href="mailto:contact@trainingsharks.com">contact@trainingsharks.com</a>
        </p>
      </div>
    </main>
  );
}
