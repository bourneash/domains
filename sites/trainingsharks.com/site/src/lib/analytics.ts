// GA4 is consent-gated: nothing loads until the visitor explicitly accepts.
// The measurement ID is hardcoded rather than an env var because .env is
// gitignored and the build runs on Cloudflare, where it would be absent.
const GA_ID = "G-XXXXXXXXXX"; // TODO: replace via the ga4-admin skill on launch
export const CONSENT_KEY = "ts_consent";

export function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}

export function initAnalytics() {
  if (!hasConsent()) return;
  if (GA_ID.includes("XXXX")) return; // not wired yet — never ship a broken tag
  if (document.getElementById("ga4")) return;

  const s = document.createElement("script");
  s.id = "ga4";
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(s);

  const w = window as unknown as { dataLayer: unknown[]; gtag: (...a: unknown[]) => void };
  w.dataLayer = w.dataLayer || [];
  w.gtag = function gtag(...args: unknown[]) {
    w.dataLayer.push(args);
  };
  w.gtag("js", new Date());
  w.gtag("config", GA_ID, {
    anonymize_ip: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false
  });
}
