import { useEffect, useState } from "react";
import { CONSENT_KEY, initAnalytics } from "../../lib/analytics";

export function CookieBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(CONSENT_KEY)) setShow(true);
    } catch {
      /* storage blocked: don't nag, and don't track either */
    }
  }, []);

  const decide = (granted: boolean) => {
    try {
      localStorage.setItem(CONSENT_KEY, granted ? "granted" : "denied");
    } catch {
      /* ignore */
    }
    setShow(false);
    if (granted) initAnalytics();
  };

  if (!show) return null;
  return (
    <div className="cookie" role="dialog" aria-label="Cookie choices">
      <div className="cookie__text">
        We use analytics cookies only if you say yes. The trainer itself runs entirely in your
        browser and needs no tracking to work. See our <a href="/privacy">privacy policy</a>.
      </div>
      <div className="cookie__actions">
        <button className="cookie__btn" onClick={() => decide(false)}>
          Decline
        </button>
        <button className="cookie__btn cookie__btn--accept" onClick={() => decide(true)}>
          Accept
        </button>
      </div>
    </div>
  );
}
