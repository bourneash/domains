# xxxtea Design System

Locked. Don't deviate without writing why first.

## The brand position

A 100% legitimate tea and tea-ware review authority that *looks* like a
fragrance ad campaign. SFW in copy. Sultry in styling. The reader's
brain does the rest.

The model is **Liquid Death applied to tea**. Edgy aesthetic, ritual-product
utility. Both halves are essential.

## The voice

- **Slow. Confident. Never tries too hard.** A double-entendre that's
  *visibly* trying breaks the spell
- **Sentence-length copy.** Editorial punchy, not blog-post wordy
- **Use real tea terminology unironically.** The vocabulary already does
  the work — *steep*, *brew*, *infuse*, *bind*, *bloom*, *full-bodied*,
  *long pour*, *deep*, *slow*, *oversteeped*, *robust*, *tight*. Let it
  land. Don't underline it
- **Restraint is the joke.** If you can read the line three times before
  catching the second meaning, that's the right line
- **Never vulgar.** Never crude. Never explicit. The frame is "fragrance
  ad," not "men's magazine"
- **No exclamation marks. No emoji. Never "lol." Never "spicy."**

### Voice examples

- ✅ "Two minutes too long and it's a different cup entirely."
- ✅ "Loose leaf. Hot water. Patience. Nothing complicated about it."
- ✅ "Bind it tight. Drop it in. Walk away."
- ✅ "Full-bodied. Deep finish. Stains the porcelain."
- ❌ "Get *NAUGHTY* with these 🔥 tea picks!" — too obvious
- ❌ "Sexy steeping for the kinky tea drinker" — never name the joke
- ❌ "XXX-rated black tea" — the domain already said it; don't repeat it

## The palette

| Token         | Hex       | Use                                          |
|---------------|-----------|----------------------------------------------|
| `steep-900`   | `#0a0805` | Page background — soaked oolong dark         |
| `steep-800`   | `#15110a` | Card surfaces                                |
| `steep-700`   | `#1f1810` | Section dividers                             |
| `steep-500`   | `#3a2e1f` | Hover lift on cards                          |
| `steep-300`   | `#8a7458` | Secondary text                               |
| `steep-100`   | `#e8dbc4` | Body text on dark                            |
| `porcelain`   | `#f5ede0` | Display headlines on dark                    |
| `honey-500`   | `#ffb300` | **Primary brand mark / CTA** — wet amber     |
| `honey-400`   | `#ffc949` | Hover states                                 |
| `honey-300`   | `#ffd97a` | Soft glow                                    |
| `honey-600`   | `#e69400` | Active / pressed                             |
| `hibiscus-500`| `#c2185b` | Secondary accent — hibiscus / rooibos        |
| `jade-500`    | `#4a7c3a` | Reserved accent — matcha callouts only       |
| `brass`       | `#b08d57` | Vessel/metal tone in product shots           |

**Rule:** white space is `steep-900`. Amber is *rare* — only on brand
mark, primary CTAs, and one accent per page. If everything glows, nothing
does. Hibiscus and jade are reserved — herbal and matcha categories only.

## Type

- **Display (Cormorant Garamond):** Serif. Italic-allowed, large. The
  emotional weight. Italic is reserved for the `xxx` half of the wordmark,
  punch lines, and pull quotes. Cormorant is more curvy and lush than
  Playfair — closer to a perfume bottle label
- **Sans (Outfit):** UI, body, metadata, navigation, buttons. Slightly
  rounded — friendlier than Inter without being soft
- **Mono (JetBrains Mono):** Steep times, temperatures, weights, SKU
  codes. Set tiny in `steep-300`

Letter-spacing of `0.36em` (the `tracking-brand` token) is reserved for
the all-caps eyebrow `xxx · tea` lockup.

## The wordmark

`xxx` is `honey-500`, italic, regular weight serif. `tea` is `porcelain`,
regular, no italic. The two are kerned tight (no gap). A 60×3px
`honey-500` underbar sits beneath `xxx` only. Never wrap. Never tilt.
Never shadow. Never stretch.

## Photography

The fragrance-ad rules are non-negotiable. See `ops/prompts/Primer_images.md`
and `ops/prompts/Primer_video.md` for the locked aesthetic. Every shot:

- **Macro fragrance-ad.** Extreme close-up, raking sidelight at near-zero
  angle, single dominant source, massive shadows. Hasselblad / Arri
  references
- **Subject:** loose tea, silk pyramids, paper bags, mesh infusers, brushed
  brass strainers, dark slate. Material tension and fluid physics
- **Single neon accent per frame.** Amber by default — but cyan, magenta,
  emerald, chartreuse, gold are acceptable as long as ONE owns the frame
- **No people.** No hands. No faces. Ever
- **No suggestive arrangement that mimics human anatomy.** The eroticism
  is in the light, micro-movement, material tension, and fluid physics —
  never in form
- **OG images** match the OG default template — radial gradient, fine
  grain overlay, serif headline, single amber underbar

## Layout

- **Generous negative space.** Editorial. Not blog
- **One column, wide measure.** 720-840px content width on desktop. Big
  type
- **Section dividers are 1px `honey-500` rules**, never gradient, never
  thicker
- **Cards are `steep-800` on `steep-900`** — barely a shadow. Hover lifts
  to `steep-500`
- **Buttons:** primary is solid honey on steep-900 text (high contrast).
  Ghost is steep-300 border, hover to honey

## What's never on this site

- No "sexy" copy. No vulgarity. No emoji
- No stock photos of people. No suggestive photography of any kind. The
  fragrance-ad frame is the only frame
- No "you naughty thing" addressing the reader
- No reference to the literal "XXX" interpretation — the domain already
  did that work; explaining it kills it
- No flashing GIFs. No autoplay carousels with audio. No popups beyond an
  optional email capture (deferred)
- No "BUY NOW!!" CTAs. The CTA is always sentence case

The site reads as confident, expensive, and *just* aware of what it
sounds like. Never more.
