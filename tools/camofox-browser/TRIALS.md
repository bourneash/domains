# Live trials

## 2026-09-09 — X setup-process validation for allthingsmasonic.com

Result: **passed with human security handoff**. The revised X signup script
created and confirmed `@MasonicThings`, saved credentials without storing the
temporary SMSPool number, and stopped after the logged-in account check.

- Current X placeholder-only fields are supported (`Full name`, `Username`,
  and `Password`).
- Settings routes are no longer visited by signup automation.
- Output is compact by default; repetitive click diagnostics require
  `X_VERBOSE=1`.
- Handoff printed: verify recovery email, enable authenticator-app 2FA/save
  backup codes, then remove the temporary signup phone.

## 2026-09-09 — X signup for 0xroulette.com

Result: **account created; owner completed security follow-up**. Camofox
Browser 1.14.0 created a persistent, logged-in X account on the first SMS
rental through the dedicated US VPN exit. The live account is
[@Play0xRoulette](https://x.com/Play0xRoulette); the exact `@0xRoulette` handle
was already taken, and no `dotcom` fallback was used.

Validated capabilities:

- The rotating proxy on port 8183 was rejected at preflight because it resolved
  to Melbourne, Australia. Camofox was restarted on the dedicated US proxy at
  port 8181, which resolved to Jersey City, New Jersey.
- X rendered the live signup chooser, accepted the first SMSPool rental, and
  delivered a code without a CAPTCHA or dead-button failure.
- Phone/email discoverability was switched off before the number was submitted.
- The exact `@0xRoulette` handle failed X's availability check;
  `@Play0xRoulette` was checked live, reported available, and claimed.
- X's signup name validator rejected both `0xRoulette` and `0x Roulette` but
  accepted the temporary display spelling `Zero X Roulette`.
- Optional interests, passkey enrollment, and browser notifications were
  skipped. The final `/home` and public-profile UI independently confirmed the
  logged-in `Zero X Roulette @Play0xRoulette` account.
- Credentials were written to Vaultwarden and the persistent Camofox session
  survived a clean shutdown/restart.

Follow-up and outstanding limitations:

1. During automation, `/settings/account`, `/settings/email`, and the
   account-information route repeatedly returned X's own `Something went
   wrong` state; a clean browser restart did not change it. The owner completed
   the security setup and removed the signup phone later on 2026-09-09.
2. The profile editor accepted the stylized name, bio, and website and returned
   success on Save, but none persisted publicly, even after retrying with native
   keyboard and blur events. The public display name remains `Zero X Roulette`.
3. No avatar was uploaded. The candidate local brand image was staged, but the
   external-egress safety gate required file-specific owner approval before it
   could be sent to X.
4. X exposed the temporary SMS number in the accessibility snapshot. The local
   sensitive trace was removed, and the owner subsequently removed the number
   from the X account.
5. The upstream client-side-navigation `unhandledRejection` (`Cannot read
   properties of undefined (reading 'url')`) recurred heavily on settings
   routes. Normal signup interactions and persistence still worked.

## 2026-09-08 — X signup for girlpain.com

Result: **passed**. Camofox Browser 1.14.0 created and retained a complete,
logged-in X account on the first SMS rental through the fleet's rotating US VPN
exit. The verified public account is [@girlpaindotcom](https://x.com/girlpaindotcom).

Validated capabilities:

- Camoufox launched behind `127.0.0.1:8183`; the exit resolved to Ashburn,
  Virginia, US (GSL Networks).
- X rendered successfully without a bot challenge.
- Accessibility snapshots exposed the signup controls and live page state.
- Ref clicks advanced through the phone and SMS screens where CloakBrowser had
  previously suffered dead/occluded button failures.
- Keyboard-mode entry preserved the ten-digit phone number and triggered a real
  SMS send.
- SMSPool Twitter service accepted the first rented US number and delivered the
  verification code.
- Birthday selection worked through `/evaluate`; the account used the fleet's
  established January 1, 1992 test date.
- Optional phone discoverability, interests, passkey, and notifications were
  declined/skipped.
- The favicon PNG attached through `/upload`, the crop applied, and the avatar
  is visible on the public profile.
- The final logged-in UI independently showed `GirlPain @girlpaindotcom` and
  reached `/home` before credentials were written to Vaultwarden and the fleet
  registry was marked active.
- Session tracing and persistent storage were enabled for the trial.
- After a clean shutdown/restart, the same `girlpain.com::x` session restored
  `/home` as logged in to `@girlpaindotcom` without another SMS challenge.

Observed limitations:

1. The X onboarding avatar screen accepted and cropped the file, but its final
   upload button did not advance. Skipping that optional step and uploading from
   `/settings/profile` worked.
2. X's profile editor has three file inputs. Camofox `/upload` always selects
   the first existing file input before considering the supplied ref, so the
   banner input had to be made non-file temporarily to target the avatar input.
3. Accessibility refs can become stale across X's client-side route changes
   even when the displayed snapshot still looks current. One stale cookie-button
   ref activated navigation instead. Prefer a fresh snapshot immediately before
   each ref action; use a narrowly scoped selector when route churn is visible.
4. Bio and website field values could be entered, but X's Save action did not
   persist them during this run. The avatar did persist. Treat profile-text
   completion as a separate follow-up until that interaction is diagnosed.
5. X client-side navigation repeatedly produced an upstream Camofox
   `unhandledRejection` (`Cannot read properties of undefined (reading 'url')`).
   Requests continued to work and persistence survived restart, but this should
   be reported upstream with the saved trace before relying on long X sessions.
6. `npm audit --omit=dev` reports six moderate transitive advisories through
   `camoufox-js`, including `adm-zip`; npm reports no fix for the direct Camofox
   dependency at 1.14.0. There are no high or critical advisories.

Security follow-up: X included the signup password value in an accessibility
snapshot, so that original password existed in the private local tool transcript.
On 2026-09-09 the owner completed the security follow-up: the account password
was rotated, non-SMS 2FA and recovery were configured, the signup phone number
was removed, and the account was confirmed working. No password is present in
tracked files.

Naming follow-up: X assigned `@girlpaindotcom` after the preferred `@girlpain`
was unavailable. The owner accepted it for this account but does not want
`dotcom` suffixes used as a routine fallback. For future signups, try clean
brand variants and pause if none are available rather than silently accepting a
domain-spelled-out handle.

No X API/developer credentials were created. The account is suitable for browser
automation trials, but `social-hub` should not enable its X adapter until OAuth
credentials and X posting credits exist.
