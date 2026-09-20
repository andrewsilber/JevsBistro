# JevsBistro working conventions

- Keep simulation modules independent of rendering, browser APIs, and live network calls.
- Controllers receive observed state and feasible candidates, never the omniscient Simulation instance.
- Preserve deterministic guest schedules. Do not consume scenario RNG from policy or rendering code.
- Keep live API secrets server-side. Camera-assisted rules must never be presented as Jev inference.
- Run `npm test` and `npm run build` for simulation changes. Run the appropriate Playwright checks for UI changes.
- Configuration is immutable during service. Future editors should modify a separate pre-run restaurant definition.
- Do not publish, push to a remote, or choose a public license unless requested.
