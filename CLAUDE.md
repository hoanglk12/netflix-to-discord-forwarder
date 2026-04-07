# Project Notes

- Keep secrets in local files referenced by environment variables.
- Do not commit OAuth credentials, OAuth tokens, checkpoints, or runtime logs.
- Prefer deterministic logging and safe checkpoint writes over in-memory-only state.
- Treat Discord delivery as successful only on a 2xx webhook response.