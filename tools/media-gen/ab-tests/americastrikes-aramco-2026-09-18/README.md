# AmericaStrikes renderer A/B — 2026-09-18

Same AmericaStrikes pipeline prompt, generated through the live `media-gen`
HTTP service with a 16:9 target.

- **A — `a-comfyui.png`:** current default, `backend=comfyui`, fast profile,
  FLUX Schnell. API image id: `cda3ea642ffc4449a592324428ed5456`.
- **B — `b-codex.png`:** new `backend=codex`, subscription-backed Codex
  `$imagegen`. API image id: `522486c187f74aa48f22d1f6d9a458b8`.
- **`comparison.png`:** display-normalized, labeled side-by-side composite.

## Prompt

> an oil-lamp-lit study globe turned to a gulf coastline, one fingerprint
> smudge over the water. Every visible surface is plain, blank, unmarked, and
> unbranded — no real national flags, insignia, uniforms, or identifiable
> people. Render this as expressive ink-and-watercolor illustration on
> cold-press paper. Use a wide environmental view with the important object
> small but unmistakable. Use a palette of aged brass, midnight navy, and warm
> lamplight ivory. Single warm lamp source against a dark room, everything else
> in near-black. Show one clear editorial-illustration idea representing the
> theme, not a literal depiction of any real event, military unit, or person.
> No words, no letters, no numbers, no code, no writing, no signage, no logos,
> no typography, and no readable text anywhere in the frame.

## Visual read

The ComfyUI result is attractive but violates the no-text constraint and puts
the fingerprint on the Americas rather than the requested Gulf coastline. The
Codex result follows the geography, medium, lighting, palette, wide framing,
and no-text constraint materially more closely.
