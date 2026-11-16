+++
id = "01M78HR5R3CEMA5BMSJBRNW2FX"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "8c9c0fa8-9eab-44f6-bd1a-f35ec235a3fc/interactive"
at = "2026-11-12T18:54:01Z"
+++
devenv/uv keep a venv in .devenv/state/venv, outside the tree: never share it across commits in a pool slot. The pool skips its built-in uv sync when UV_PROJECT_ENVIRONMENT is absolute (casos points three uv.lock dirs at one venv).
