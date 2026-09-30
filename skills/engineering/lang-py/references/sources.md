# lang-py sources

The refresher reads this table, checks each source for a newer release, and updates the version in SKILL.md and here.

| item | kind | version targeted | checked on | source |
|---|---|---|---|---|
| CPython | language | 3.14.8 (3.15.0 due 2026-10-01) | 2026-09-30 | https://www.python.org/ftp/python/ , https://peps.python.org/pep-0790/ , https://docs.python.org/3/whatsnew/3.14.html |
| uv | tool | 0.12.21 | 2026-09-30 | https://github.com/astral-sh/uv/releases |
| ruff | tool | 0.16.9 | 2026-09-30 | https://github.com/astral-sh/ruff/releases , https://docs.astral.sh/ruff/linter/ |
| basedpyright | tool | 1.40.1 | 2026-09-30 | https://github.com/DetachHead/basedpyright/releases |
| pyright | tool | 1.1.414 | 2026-09-30 | https://github.com/microsoft/pyright/releases |
| ty | tool | 0.0.84 (beta, no stable API) | 2026-09-30 | https://github.com/astral-sh/ty , https://github.com/astral-sh/ty/milestone/4 |
| mypy | tool | 2.3.1 | 2026-09-30 | https://pypi.org/pypi/mypy/json |
| pytest | library | 9.1.1 | 2026-09-30 | https://pypi.org/pypi/pytest/json |
| pytest-asyncio | library | 1.4.0 | 2026-09-30 | https://pypi.org/pypi/pytest-asyncio/json |
| anyio | library | 4.15.1 | 2026-09-30 | https://pypi.org/pypi/anyio/json |
| Hypothesis | library | 6.168.3 | 2026-09-30 | https://hypothesis.readthedocs.io/en/latest/changelog.html , https://hypothesis.readthedocs.io/en/latest/reference/api.html |
| syrupy | library | 6.1.1 | 2026-09-30 | https://github.com/syrupy-project/syrupy/releases |
| mutmut | tool | 3.8.0 | 2026-09-30 | https://github.com/boxed/mutmut |
| cosmic-ray | tool | 8.7.0 (alternative, less active) | 2026-09-30 | https://github.com/sixty-north/cosmic-ray |
| atheris | library | 3.1.0 (CPython 3.11 to 3.14) | 2026-09-30 | https://github.com/google/atheris , https://pypi.org/pypi/atheris/json |
| HypoFuzz | tool | 25.11.1 (stale, not recommended) | 2026-09-30 | https://pypi.org/pypi/hypofuzz/json |
| devenv languages.python | doc | options `uv.enable`, `uv.sync.enable`, `venv.enable`, `version` | 2026-09-30 | https://devenv.sh/languages/python/ |

## Luiz's repos read

- `~/repos/coelhorocha/custom-mcp-servers` (about 110 .py, ML and pipeline code beside a TypeScript repo): one exception per failure named for it; `from __future__ import annotations` nearly everywhere; dataclasses, rare Protocol and TypedDict, no pydantic; pytest run through `uv run --with pytest`; `tasks/check-python` as the lint gate instead of ruff; ProcessPoolExecutor capped (default 2, max 4) after the RAM incident; Modal CLI kept out of devenv `packages`. Memo: worker-pool RAM, `devenv mcp` RAM, Modal queues silently at GPU capacity.
- `~/repos/coelhorocha/crm-contract-tasks` (Lambda functions): virtual uv workspace with `uv.lock`, devenv `uv.enable` + `uv.sync.enable`, uv from astral's release; pytest with `integration` marker deselected by default, pytest-asyncio auto mode; exception hierarchy mapped to status codes; black, isort, flake8, non-strict mypy.
- `~/repos/luizhcrocha/skills` (tstack): stdlib only, Python 3.11 or newer, unittest, `#!/usr/bin/env python3`, argparse, one exception per tool (`MemoError`, `JJError`), errors to stderr.
- Global `~/.claude/CLAUDE.md`: uv in every repo; latest release of every CLI.

## Open questions

- custom-mcp-servers breaks the uv rule: devenv `venv.enable` with hand-pinned `requirements.txt` (two copies). Move it to a uv project with `uv.lock`?
- No repo uses ruff or basedpyright yet. crm-contract-tasks (black, isort, flake8 at 120 vs black's 88, mypy non-strict) and custom-mcp-servers (a custom `ast` check that deliberately avoids an install) each chose otherwise. Should either migrate, and is `select = ["ALL"]` the right default for new projects or too loud?
- Test runner: pytest in the app repos, unittest in tstack by design. Confirmed as intended; no change proposed.
- crm-contract-tasks uses pytest-mock. The skill keeps mocking libraries off our own modules; is that repo's usage limited to third-party clients?
- Logging: print in custom-mcp-servers, logging in crm-contract-tasks. The skill says CLIs print (stdout result, stderr diagnostics) and services log; confirm.
- Python floor differs per repo (3.11, 3.12, 3.13 locally with a 3.12 Modal image). Nothing to unify; each repo's pin wins.
