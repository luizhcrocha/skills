import type { Context, ESTree } from "@oxlint/plugins";

export const allowlistProperties = {
  allow: {
    type: "object" as const,
    additionalProperties: { type: "integer" as const, minimum: 1 },
  },
};

export const allowlistSchema = [
  {
    type: "object" as const,
    properties: allowlistProperties,
    additionalProperties: false,
  },
];

type AllowlistOptions = [] | [{ allow?: Record<string, number> }];

function allowance(context: Context) {
  const filename = context.physicalFilename.replaceAll("\\", "/");
  const [options] = context.options as AllowlistOptions;

  return Object.entries(options?.allow ?? {}).find(
    ([path]) => filename === path || filename.endsWith(`/${path}`),
  );
}

export function reportAllowed(
  context: Context,
  program: ESTree.Program,
  violations: readonly ESTree.Node[],
  messageId: string,
) {
  const [path, count] = allowance(context) ?? ["", 0];

  if (violations.length < count) {
    context.report({
      node: program,
      messageId: "stale",
      data: { path, count: String(violations.length) },
    });

    return;
  }

  if (violations.length === count) {
    return;
  }

  for (const node of violations) {
    context.report({ node, messageId });
  }
}
