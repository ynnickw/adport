# Adport submission icons

Exact raster exports of `apps/cloud/app/icon.svg`: the orange `#ff6b00` dot on a
transparent square. No old logo, generated artwork, or third-party mark.

- `adport-directory.png`: 512 × 512 PNG (portal minimum 256 × 256).
- `adport-composer.png`: 128 × 128 PNG (portal minimum 48 × 48).

Regenerate from the repository root:

```sh
node apps/cloud/scripts/render-submission-icons.mjs
```

The script uses the Sharp renderer included with the installed Next.js package
and validates dimensions, PNG format, and alpha. Inspect both rendered files
before upload. These files do not by themselves prove the portal upload saved.
