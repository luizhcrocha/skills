+++
id = "01M41P1DSX8KVVS056G5R8VSQX"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "3642a3e1-f620-40cd-9c28-c4002130b266/interactive"
at = "2026-10-03T20:07:12Z"
+++
fleet/bin/fleet forwards to the highest-versioned tstack on the machine; a workspace whose plugin.json is lower than the main checkout's runs the main checkout's fleet. Tests and gates now set FLEET_NO_FORWARD=1; set it by hand to run a workspace's own copy.
