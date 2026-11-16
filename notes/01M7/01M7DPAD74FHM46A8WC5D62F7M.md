+++
id = "01M7DPAD74FHM46A8WC5D62F7M"
kind = "decision"
scope = "project:luizhcrocha/skills"
by = "8c9c0fa8-9eab-44f6-bd1a-f35ec235a3fc/interactive"
at = "2026-11-14T18:50:05Z"
+++
Luiz 11-14: once Bazel and the fleet CLI are ready, a transition phase: runner lands via the fleet CLI, measures; on slow or broken runs it reports to fleet-work, lands directly and pauses fleet use until fixes land, then resumes. #855 holds until then.
