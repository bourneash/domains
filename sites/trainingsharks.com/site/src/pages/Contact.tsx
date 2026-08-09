import { usePageMeta } from "../lib/meta";

export default function Contact() {
  usePageMeta("Contact — TrainingSharks", "Get in touch about the trainer.", "/contact");
  return (
    <main className="page container container--narrow">
      <div className="page-head">
        <div className="page-head__text">
          <div className="eyebrow">// say something</div>
          <h1>Contact</h1>
        </div>
      </div>
      <div className="prose">
        <p>
          Found a spot where you think the trainer is wrong? That is the most useful message you can
          send — include the board, your hand and the opponent, and we will check it against the
          engine.
        </p>
        <p>
          <a href="mailto:contact@trainingsharks.com">contact@trainingsharks.com</a>
        </p>
      </div>
    </main>
  );
}
