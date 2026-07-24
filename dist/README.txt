Static export of the Forge Graph EDITOR (web build).

Each visitor gets a private workspace in their own browser (IndexedDB).
Nothing is uploaded; there is no server and no shared state. Depth, AI
and video nodes are disabled - they need ComfyUI/ffmpeg locally.

index.html  the node editor
play.html   the visitor's own authored UI, from their browser storage

Serve this folder at the ROOT of a domain (Cloudflare Pages, Netlify,
S3+CloudFront). Asset paths are root-absolute, so a GitHub Pages project
subpath (user.github.io/repo/) will NOT work without a custom domain.

Local check:  python -m http.server 8000
