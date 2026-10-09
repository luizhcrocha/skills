+++
id = "01M4HVRRVSXTM3NX975N9FXYF6"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "3642a3e1-f620-40cd-9c28-c4002130b266/interactive"
at = "2026-10-10T02:55:11Z"
+++
The fleet hub serves the page from the main checkout's working copy (~/repos/luizhcrocha/skills/fleet), not the plugin cache. A release is live only after that checkout's @ is rebased onto master@origin and fleet-hub restarts (1.9.26 served the old page until then).
