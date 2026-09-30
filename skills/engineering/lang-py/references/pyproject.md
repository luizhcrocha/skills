# Starter pyproject and devenv for a new Python project

Load when creating a Python project or adding the gates to one that has none. Versions come from `uv add`, which resolves the latest release; never type them from memory.

```sh
uv init --package <name>        # src/ layout, pyproject.toml, .python-version
uv add --dev ruff basedpyright pytest hypothesis syrupy
```

```toml
[project]
requires-python = ">=3.14"

[tool.ruff]
line-length = 88

[tool.ruff.lint]
select = ["ALL"]
ignore = [
  "D",       # docstrings: names and types carry the meaning; comments only for the why
  "COM812",  # conflicts with ruff format
  "ISC001",  # conflicts with ruff format
]

[tool.ruff.lint.per-file-ignores]
"tests/**" = ["S101", "PLR2004", "ANN"]  # assert, literal expectations, fixtures untyped

[tool.basedpyright]
typeCheckingMode = "recommended"

[tool.pytest.ini_options]
addopts = "-m 'not integration'"
markers = ["integration: talks to a real dependency; run with -m integration"]
```

A `ruff check` that lights up hundreds of findings on an existing repo is not fixed in the same change as a feature. Adopt `ALL` in its own change, or start from the repo's current rule set and add families one change at a time.

## devenv

```nix
languages.python = {
  enable = true;
  version = "3.14";
  uv.enable = true;
  uv.sync.enable = true;   # uv sync on shell entry, from uv.lock
};
```

`uv.package` defaults to nixpkgs' uv, which lags. When it is behind the latest release, point `uv.package` at astral's release binary (dotfiles `pkgs/uv.nix` is the pattern: `stdenvNoCC.mkDerivation` over the release tarball with the vendor-published sha256) and say which version went in.

## Hypothesis state machine skeleton

```python
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule


class StoreMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.store = Store()          # the real thing
        self.model: dict[str, int] = {}  # the dumb model

    @rule(key=st.text(min_size=1), value=st.integers())
    def put(self, key: str, value: int) -> None:
        self.store.put(key, value)
        self.model[key] = value

    @invariant()
    def agrees(self) -> None:
        assert dict(self.store.items()) == self.model


TestStore = StoreMachine.TestCase
```
