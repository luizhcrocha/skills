import { defineRule } from "@oxlint/plugins";

import { resolveVariable } from "../../anti-slop/shared/scope.ts";

import type { ESTree, SourceCode } from "@oxlint/plugins";

function importedName(node: ESTree.Node): string | null {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function isTestFrameworkObject(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  if (expression.type !== "Identifier") return false;
  const framework = expression.name === "vi" || expression.name === "jest";
  if (framework && sourceCode.isGlobalReference(expression)) return true;

  const variable = resolveVariable(sourceCode, expression);
  if (variable === null || variable.defs.length === 0) return framework;
  return variable.defs.some((definition) => {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") {
      return false;
    }
    const source = definition.parent.source.value;
    const name = importedName(definition.node);
    return (source === "vitest" && name === "vi") || (source === "@jest/globals" && name === "jest");
  });
}

function isSpyOnCall(sourceCode: SourceCode, callee: ESTree.Expression): boolean {
  if (callee.type !== "MemberExpression") return false;
  if (!isTestFrameworkObject(sourceCode, callee.object)) return false;
  const property = callee.property;
  if (callee.computed) return property.type === "Literal" && property.value === "spyOn";
  return property.type === "Identifier" && property.name === "spyOn";
}

/** Ban Vitest and Jest method spies: behaviour is replaced through a seam, never patched in place. */
export const noSpyOnRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow vi.spyOn and jest.spyOn; tests replace a dependency through a seam instead of patching it.",
    },
    messages: {
      spyOn:
        "Replace the spy with a seam: pass the dependency (a logger, a clock, a serializer) through a parameter, constructor or layer and hand the test a recording fake. To quiet console output in tests, use Vitest's `silent: \"passed-only\"`.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        if (isSpyOnCall(context.sourceCode, node.callee)) {
          context.report({ node, messageId: "spyOn" });
        }
      },
    };
  },
});
