---
name: lang-py
description: "Python rules and taste for tstack: uv environments, ruff, basedpyright, pytest and Hypothesis, bounded worker pools. Use when writing, reviewing or testing Python code."
paths: ["**/*.py", "**/pyproject.toml", "**/uv.lock"]
---

# lang-py

## Version target

Python 3.14 (3.14.8), uv 0.12.21, ruff 0.16.9, basedpyright 1.40.1, pytest 9.1.1, Hypothesis 6.168.3, checked 2026-09-30 ([sources](references/sources.md)). Python 3.15.0 is due 2026-10-01; the refresher moves the target when it ships.

A project's pinned version wins. Read `requires-python` in `pyproject.toml`, `.python-version`, and `languages.python.version` in `devenv.nix` first, and write code that runs on the lowest version they allow (a Modal or Lambda image may pin an older minor than the dev shell).

tstack's own tooling (`scripts/*.py`, extensionless scripts, `hooks/tstack-hook`, the coordinator) is the exception on purpose: standard library only, Python 3.11 or newer, `unittest`, run with plain `python3`, no pyproject and no dev shell. Keep it that way; the plugin must run on any machine with a `python3`.

## Non-negotiables

- **uv owns every environment** (Luiz's rule). In devenv: `languages.python.uv.enable = true;` and `uv.sync.enable = true;`, with `venv.enable` left off. Elsewhere: `uv init`, `uv add`, `uv sync`, `uv run`, `uvx`; `uv venv` and `uv pip` only for a repo that has no `pyproject.toml` yet. Plain `pip install` and `python -m venv` are never used.
- Dependencies live in `pyproject.toml`, dev tools in `[dependency-groups] dev`, and `uv.lock` is committed. A hand-kept `requirements.txt` is legacy; propose moving it to a uv project rather than extending it.
- The gates pass before a change is done: `uv run ruff format --check`, `uv run ruff check`, `uv run basedpyright`, the tests. A repo with its own gate keeps it (see Toolchain).
- Every suppression names its rule and its reason on the same line: `# noqa: S603  # argv is built from constants`, `# pyright: ignore[reportPrivateUsage]  # test reads the cache`. `typing.cast` and `Any` carry the same kind of comment.
- Catch the narrowest exception that can happen, and re-raise with `raise NewError(...) from err`. `except Exception` only at a process boundary (a handler, a CLI `main`), where it logs and maps to an exit code or status.
- Files, sockets, locks, pools and temp dirs are opened in a `with` block.
- A pool of processes that each load a model is sized from memory, never from `os.cpu_count()` (see Gotchas).

## Taste

- **Data shape first.** Domain values are `@dataclass(frozen=True, slots=True)`; variants are an `Enum`, a `Literal`, or a union of dataclasses matched with `match` and closed by `typing.assert_never`. Semantic primitives get a `NewType` (`CaseId = NewType("CaseId", str)`). A bag of optional fields where contradictory combinations type-check is a modeling bug (`principles/type-system-discipline`).
- **Parse at the boundary** (`principles/boundary-discipline`). JSON, env vars, argv, HTTP bodies and rows go through one parse function per boundary that returns the typed value or raises the boundary's error; core code takes the typed value and never re-validates. Use pydantic only in a repo that already depends on it; otherwise a small parse function over a `TypedDict` or dataclass.
- **Errors.** One exception class per failure, named for it and subclassing the closest builtin: `ParseFailed(RuntimeError)`, `UploadFailed`, `RecogniserUnavailable`. This is Luiz's style in every repo. A hierarchy (`ContractTaskError` with `ValidationError` and `ServiceError`) earns its place only when a handler maps the categories to different outcomes, as a Lambda maps them to status codes.
- **Seams.** A dependency the core calls (clock, randomness, HTTP, subprocess, storage) is a parameter typed by a `Protocol` or a plain `Callable`, with a production default at the edge. `random.Random(seed)` is passed in, never the module-level `random`.
- **Modules.** A leading underscore marks module-private names. Imports at the top; a function-level import only to defer a heavy optional dependency (torch, a model SDK), with that reason in a comment.
- **Annotations.** Every public function is annotated. On 3.14 annotations are lazy, so `from __future__ import annotations` is unnecessary there; on older targets follow the repo's habit.
- **Concurrency.** asyncio for I/O-bound work (`asyncio.TaskGroup`, `asyncio.timeout`); a `ThreadPoolExecutor` with an explicit `max_workers` for blocking I/O; processes only for CPU-bound work, bounded as below. A semaphore bounds any fan-out to a remote service; a queueing backend (Modal at GPU capacity) does not bound it for you.
- **Output.** A CLI parses argv with `argparse`, prints its result to stdout and diagnostics to stderr, and returns an exit code from `main()`. A long-running service uses `logging`.
- **Naming.** PEP 8. Names say what a value is in the domain, not its type.

## Toolchain and gates

| job | tool | how |
|---|---|---|
| env, deps, lock, run | uv | `uv sync`, `uv add --dev <tool>`, `uv run <tool>` |
| format | ruff | `uv run ruff format` (`--check` in CI) |
| lint | ruff | `uv run ruff check --fix`; new projects `select = ["ALL"]` with a short `ignore` list |
| types | basedpyright | `uv run basedpyright`, `typeCheckingMode = "recommended"` |
| tests | pytest | `uv run pytest` |

- **Latest release, always.** `uv add --dev ruff basedpyright pytest hypothesis` resolves the newest; `uv lock --upgrade-package <name>` moves one; `curl -s https://pypi.org/pypi/<name>/json | jq -r .info.version` answers "what is latest". uv itself often lags in nixpkgs: take it from astral's release (dotfiles' `pkgs/uv.nix`, crm-contract-tasks' devenv) and say which version went in.
- `select = ["ALL"]` also turns on rules added in later ruff releases, so ruff is pinned in `uv.lock` and a ruff upgrade is its own change. Starter config: [references/pyproject.md](references/pyproject.md).
- **ty** (astral) is beta, `0.0.x` with no stable API. It may run as a non-blocking second opinion; basedpyright gates.
- **Repos with their own gate keep it** until Luiz asks to migrate: crm-contract-tasks runs black, isort, flake8 and mypy; custom-mcp-servers runs `tasks/check-python` (stdlib `ast`, chosen so the check never needs an install) through `pnpm check`.
- **Lint pack**: tstack's `lint/py` (`ruff.toml`), vendored with `lint-vendor add py`; a lesson that repeats becomes a rule there through `tstack:lint-evolve`.

## Testing ladder

tstack's `tdd` owns the method and the rungs; this maps them to tools.

| rung | tool |
|---|---|
| 0 static | ruff, basedpyright |
| 1 example | pytest (plain `assert`, fixtures, `@pytest.mark.parametrize`); `unittest` in tstack's own tooling |
| 2 integration | pytest with an `integration` marker, deselected by default (`addopts = "-m 'not integration'"`) and run against the real dependency |
| 3 golden | syrupy: `assert result == snapshot`, `uv run pytest --snapshot-update` to accept, review the `.ambr` diff |
| 4 property | Hypothesis `@given`; strategies build values through production constructors and parsers (`st.builds(CaseId, ...)`) |
| 5 model-based | `hypothesis.stateful.RuleBasedStateMachine` with `@rule`, `@precondition`, `@invariant`, `Bundle`; `TestStore = StoreMachine.TestCase` |
| 6 fuzzing | atheris 3.1.0 (CPython 3.11 to 3.14, Linux and macOS); a `@given` test's `.hypothesis.fuzz_one_input(data)` for an external fuzzer |
| 7 mutation | mutmut 3.8 (`uv run mutmut run`, `mutmut browse`, `[tool.mutmut]`; POSIX only) |
| 8 simulation | none standard; inject clock, randomness and I/O through seams so a later harness can drive them |

Async tests use pytest-asyncio 1.x (`asyncio_mode = "auto"`) or anyio's `@pytest.mark.anyio`, whichever the repo already has. Substitutes go through the seams above as hand-written fakes. `unittest.mock.patch`, `monkeypatch.setattr` and pytest-mock stay off our own modules; they are for third-party code with no seam, and even there an adapter with a fake is preferred.

## Gotchas

- **Worker pools multiply RAM.** 26 `ProcessPoolExecutor` workers, each loading an ML model, took 58 GB RSS plus 518 GB of swap and froze a 62 GB machine (2026-09-25). Default to 2 workers, cap at 4, read free memory before raising it, and never let several agents run model-loading Python at once.
- Each Claude session that loads a devenv MCP server starts its own `devenv mcp` of about 4 GB; many sessions exhaust RAM before Python does.
- devenv merges the site-packages of every Python package in `packages` into the venv profile. A Python CLI with its own closure (the Modal CLI) is wrapped as just its binary, or kept out of `packages`.
- custom-mcp-servers keeps two hand-synced `requirements.txt` copies (lab and container) and runs tests as `uv run --with pytest --python 3.13 pytest ...`; its Modal image is Python 3.12, so container code must run on 3.12.
- crm-contract-tasks is a virtual uv workspace (`package = false`), which cut Lambda zips from 15 MB to 4 MB; `boxsdk` stays `<4` (the pin comment cites an outage). Its flake8 allows 120 columns while black formats at 88.
- tstack's extensionless scripts are imported in tests through `importlib.machinery.SourceFileLoader`; test files put the script dir on `sys.path` with `# noqa: E402`.
- Python 3.10 reaches end of life on 2026-10-31. atheris has no 3.15 support yet.
