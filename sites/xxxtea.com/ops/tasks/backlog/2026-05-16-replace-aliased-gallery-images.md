# Replace aliased gallery images

Three slugs currently alias to existing webps because their source PNGs
were removed during scaffold:

| slug                | currently aliased to |
| ------------------- | -------------------- |
| collar-and-chain    | bound-pyramid        |
| shibari-steep       | squeezed-silk        |
| slumping-strainer   | suspended-strainer   |

## Job

1. Regenerate the three missing PNGs via Nano Banana using the prompts
   already drafted in `ops/prompts/ideas_Image.md` (they describe each
   shot precisely)
2. Drop the new PNGs in `images_for_use/`
3. Run the gallery conversion (same `convert` commands used during
   scaffold — or write a small script)
4. Confirm `npm run build && curl gallery/<slug>-1200.webp` returns
   a unique image (file size differs from the aliased one)
5. Commit + push
