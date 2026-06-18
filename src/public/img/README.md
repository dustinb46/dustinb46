# Site imagery

Drop image files here to use them in the UI. They're served at `/img/<name>`.

## Hero background photo

The homepage hero shows a dairy photo when one is present, layered over a
green gradient that always renders as a fallback.

To enable a photo:

1. Add a wide landscape image at `src/public/img/hero.jpg`
   (recommended ~1600×900 or larger, JPG, optimized under ~300 KB).
2. In `src/public/style.css`, set the `--hero-photo` variable in `:root`:
   ```css
   --hero-photo: url('/img/hero.jpg');
   ```
3. Commit and deploy. The hero text stays readable because a dark scrim
   (`.hero-overlay`) sits between the photo and the text.

If the file is missing or fails to load, the gradient shows — nothing breaks.

## Licensing

Only use images you have the rights to. Good free, commercial-use sources
(no attribution required):

- Unsplash — https://unsplash.com/s/photos/dairy-farm
- Pexels — https://www.pexels.com/search/dairy%20farm/

Download the file and commit it here rather than hotlinking, so the site
doesn't depend on an external host staying up.
