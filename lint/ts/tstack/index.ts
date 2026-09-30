import { eslintCompatPlugin } from "@oxlint/plugins";

import { noSpyOnRule } from "./rules/no-spy-on.ts";

/** tstack's own Oxlint rules: lessons from Luiz's repos, registered in tstack's lint/registry.toml. */
const tstackPlugin = eslintCompatPlugin({
  meta: { name: "tstack" },
  rules: {
    "no-spy-on": noSpyOnRule,
  },
});

export default tstackPlugin;
