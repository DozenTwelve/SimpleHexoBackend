# Hexo Blog Backend

A lightweight file-based API for managing a Hexo blog (posts live in `posts/` and assets alongside). Provides endpoints for creating/editing posts, uploading images, managing tags, triggering Hexo builds, and orchestrating Obsidian-style note uploads.

## Requirements
- Node.js 18+ (tested with 22)
- Hexo installed in the project root (uses `npm run build` for the build hook)

## Config
Environment variables:
- `BLOG_API_PORT` (default: `4001`)
- `BLOG_API_TOKEN` (required; any non-empty string)

Paths:
- Posts root: `posts/`
- Upload sessions: `uploads/sessions/`
- Tags store: `tags.json`

## Run
```bash
BLOG_API_TOKEN=yourtoken BLOG_API_PORT=4001 npm run backend
```

## API Overview (token required via `Authorization: Bearer <token>`)
- `GET /api/posts` — list posts
- `POST /api/posts` — create post `{title, content, slug?, date?, meta?}`
- `GET /api/posts/:folder` — load post
- `PUT /api/posts/:folder` — update post `{title?, content?, meta?}`
- `DELETE /api/posts/:folder` — delete post
- `POST /api/posts/:folder/images` — upload image `{filename, data(base64)}`; appends gallery block to markdown and returns updated content
- `POST /api/tags` / `GET /api/tags` — manage tag list
- `POST /api/build` — run `npm run build`

Obsidian upload flow:
- `POST /api/upload/session` — create session
- `POST /api/upload/note` — upload a note `{sessionId, filename, content, isMain?}`
- `POST /api/upload/archive` — upload an HTML archive for a required external link
- `POST /api/upload/commit` — finalize session `{sessionId}`
- `GET /api/upload/session/:id` — inspect session status

## Notes
- CORS is open (`*`), but all endpoints require the token.
- The server writes directly under `posts/`; ensure the process user has write permissions.
- The build endpoint shells out to `npm run build` in the project root—keep that script safe for your environment.

## Development
- Start backend: `npm run backend`
- Start admin UI: `npm run admin` (defaults to port `4002`; set `BLOG_UI_PORT` to change)
- Preview Hexo: `npm run preview` (frontend on port `4000`)
