# The start read has a fixed budget in bytes, and the store has none

Status: accepted as a direction by Luiz on 2026-11-16 (a fixed start read of about 4k tokens). The slices and the rule for a store over its slice are proposed in [docs/design/memo-v2](../design/memo-v2/design.md).

On 2026-11-06 the default start read became a "brief" with no size limit. In custom-mcp-servers it grew to 46,517 bytes (about 11k tokens) at every session start, 46% more than the budgeted listing it replaced. The start read now has a budget of 14,000 bytes in all, divided into fixed slices: 600 for the header, 3,000 for the user scope, 1,900 for the machine, 2,500 shared by the session's groups, which are two at most, and 6,000 for the repo. A store may hold any number of notes. When a store's lines do not fit its slice, the read drops the oldest notes that no summary stands for, keeps the notes that summaries chose, and prints one line that counts what it left out.

## Considered options

- **A budget in lines** (120 in a repo and 20 global, as before; OptMem uses 96). Rejected: a line can be 280 characters, so a line count does not bound the bytes, and the target is in bytes and tokens.
- **Slices that lend unused bytes to other scopes.** Rejected: a fixed slice makes the cost of a session start the same every day, and a scope with little to say costs less.
- **A cap on what is stored** (Hermes Agent refuses a write that would overflow 2,200 characters). Rejected: memo's refused writes were dropped, not retried (2026-11-10, 11-12 and 11-16 in custom-mcp-servers).

## Consequences

- No part of the start read may be added without a slice. The code checks the total on every start, and a test fails when any path exceeds it.
- The five numbers are constants in the code. No config file sets them.
- Older notes reach a session through summaries, `memo zoom` and `memo recall`, never through a larger start read.
