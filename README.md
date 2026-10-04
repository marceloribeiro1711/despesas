# NiceShot

- `docs/` — app do participante (`index.html`) e admin (`admin.html`), publicados pelo GitHub Pages (Settings > Pages > Deploy from a branch > `main` / `docs`).
- `worker/` — API na Cloudflare (Workers & Pages > `niceshot-api` > Settings > Builds > Connect, Root directory: `worker`).

Chaves (`GOOGLE_API_KEY`, `ADMIN_KEY`, `TOKEN_SECRET`) ficam só na Cloudflare, nunca neste repositório.

Para atualizar: edite o arquivo e faça commit na branch `main`. O Pages e a Cloudflare publicam sozinhos.
