# Contributing to NeuroSquad Browser MCP

Thanks for helping! This project is fully open source (MIT) and is developed in the open through
issues and pull requests.

## Ground rules

- **Every change goes through a pull request** — including the maintainers' own. Direct pushes to
  `main` are blocked; `main` is protected and only accepts squash-merged PRs.
- Every PR needs an approving review from a code owner (see [`.github/CODEOWNERS`](.github/CODEOWNERS))
  and green CI (`ci-ok`). All review conversations must be resolved before merge.
- An AI review bot (CodeRabbit) comments on every PR. Treat its comments as suggestions: fix what is
  right, reply to what is not. It does not replace the maintainer review.
- Be kind — see the [Code of Conduct](CODE_OF_CONDUCT.md).
- For anything bigger than a small fix, open an issue (or a Discussion) first so we can agree on
  the approach before you spend time on it.

## Development setup

Requirements: Node.js LTS (22 or newer), npm, git, and Chrome (or another Chromium browser).

```sh
git clone https://github.com/glmn-ai/neurosquad-browser-mcp.git
cd neurosquad-browser-mcp
npm ci                                # repository tooling (ESLint)
npm ci --prefix server --ignore-scripts   # server dependencies, without touching your MCP client configs
npm run check                         # node --check on all JS + manifest.json validation
npm run lint
npm test                              # server tests: real server processes, fake extension
```

`npm install` in `server/` without `--ignore-scripts` runs `server/setup.js`, which adds a `webmcp`
entry to the MCP client configs it finds on your machine (see the README). Skip it while developing
if you do not want that.

To try your changes: load `extension/` with **Load unpacked** in `chrome://extensions`, press the
reload button there after every change to the extension, and restart (or `/mcp`-reconnect) your MCP
client after changes to the server. Use public pages or local test pages — not your logged-in
accounts — while experimenting.

## Repository layout

| Path         | What                                                                             |
|--------------|----------------------------------------------------------------------------------|
| `extension/` | The Manifest V3 extension (service worker, content scripts, popup). No build step. |
| `server/`    | The Node.js MCP server (stdio) and the WebSocket hub the extension connects to.    |
| `scripts/`   | Repository checks used by CI.                                                    |

## Branches

Create a branch from the latest `main`:

| Prefix       | For                                   | Example                       |
|--------------|---------------------------------------|-------------------------------|
| `feat/`      | new features                          | `feat/browser-scroll`         |
| `fix/`       | bug fixes                             | `fix/screenshot-inactive-tab` |
| `docs/`      | documentation only                    | `docs/edge-install`           |
| `refactor/`  | code changes without behavior change  | `refactor/hub-routing`        |
| `test/`      | tests only                            | `test/peer-failover`          |
| `chore/`     | tooling, CI, dependencies             | `chore/ci-node-24`            |

## Commits and PR titles: Conventional Commits

We squash-merge, so the **PR title becomes the commit message on `main`** and must follow
[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <summary in imperative mood>
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
Scopes (suggested): `extension`, `server`, `hub`, `tools`, `popup`, `setup`, `ci`.

## Pull request checklist

- [ ] One logical change per PR; small PRs get reviewed faster.
- [ ] `npm run check`, `npm run lint` and `npm test` pass; tests added or updated for server changes.
- [ ] Manually tried in Chrome with the unpacked extension; say in the PR which OS and browser.
- [ ] **Permissions stay minimal.** A new entry in `manifest.json` `permissions`/`host_permissions`
      needs a reason in the PR and in the README's security section.
- [ ] **No data leaves the machine.** The extension talks only to `127.0.0.1`; no analytics, no
      remote code, no third-party requests.
- [ ] The server binds `127.0.0.1` only and keeps its origin/token checks.
- [ ] Bump the version in `extension/manifest.json` (and `server/package.json` if the server
      changed) for user-visible changes.
- [ ] Docs/README updated if user-visible behavior changed.

## AI-assisted contributions

AI-assisted contributions are welcome. You are the author: you must have **reviewed, understood and
tested** everything you submit and be able to explain and change it during review. Low-effort
generated PRs that the author cannot explain will be closed.

## Reporting bugs and asking for features

Use the [issue forms](https://github.com/glmn-ai/neurosquad-browser-mcp/issues/new/choose). Security
problems — **not** in public issues; see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
