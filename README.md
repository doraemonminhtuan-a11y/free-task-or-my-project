# Supreme Duelist — GitHub Pages deploy

This repo contains a static HTML/JS game. `index.html` redirects to the actual game file `suprem duelist bản pc.html`.

How to deploy:

1. Push to `main` branch — GitHub Actions workflow `.github/workflows/gh-pages.yml` will publish repository root to `gh-pages` branch.
2. Go to repository Settings → Pages, and set the source to `gh-pages` branch (root). The site URL will be shown there.

If you prefer GitHub Pages from `main` branch (root), you can also enable Pages directly without Actions.
