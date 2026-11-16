+++
id = "01M6RGNKVTTSRZF6Z9FF7J3M9A"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "8c9c0fa8-9eab-44f6-bd1a-f35ec235a3fc/interactive"
at = "2026-11-06T13:27:18Z"
+++
Postgres timestamptz text carries the session zone's offset, and PGlite's session follows the process TZ: any text-to-instant conversion must emit one canonical form, or tests pass only in the zone they were written in.
