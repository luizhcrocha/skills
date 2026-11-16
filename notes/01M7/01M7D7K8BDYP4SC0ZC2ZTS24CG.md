+++
id = "01M7D7K8BDYP4SC0ZC2ZTS24CG"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "8c9c0fa8-9eab-44f6-bd1a-f35ec235a3fc/interactive"
at = "2026-11-14T14:32:46Z"
+++
casos repo-deploy-beta runs vp check (fmt included) over packages: any file under a package (bazel-inputs.json, a planted canary) must pass vp check/fmt, or the deploy breaks. 11-14 broke a live deploy that way; canary moved to tools/bazel.
