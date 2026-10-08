Static export of the Forge Graph EDITOR (web build).

Each visitor gets a private workspace in their own browser (IndexedDB).
Nothing is uploaded; there is no server and no shared state. Local AI
nodes are disabled - they need ComfyUI locally. Sequence -> Video
encodes in the browser and downloads an mp4 or a zip of frames.

index.html  the node editor
play.html   the visitor's own authored UI, from their browser storage

Drop this folder on any static host — Cloudflare Pages, Netlify,
S3+CloudFront, GitHub Pages. It works at a domain root or under a subpath
(user.github.io/repo/, or a portfolio's /forge/): the baked shader and
math-node paths are resolved against the build's own location at runtime,
not against the origin.

GitHub Pages: the repo's .github/workflows/pages.yml builds and deploys
this on every push to main (Settings > Pages > Source: GitHub Actions).
Serving a branch instead? Use its / or /docs (dist/ is not a source
folder Pages offers), and keep the .nojekyll file — without it Jekyll
strips shaders/_fullscreen.vert and every shader fails to compile. The
_headers file is a Netlify/Cloudflare thing; Pages ignores it, so expect
its own ~10 min asset cache between a push and a visible change.

Local check:  python -m http.server 8000
