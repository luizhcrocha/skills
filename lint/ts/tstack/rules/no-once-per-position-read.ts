import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type Node = ESTree.Node;

function isFunction(node: Node): boolean {
  return node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration";
}

/** Places Solid's compiler reads lazily: a `{…}` child, an attribute, a spread. */
function isReactivePlace(node: Node): boolean {
  return node.type === "JSXExpressionContainer" || node.type === "JSXAttribute" || node.type === "JSXSpreadAttribute" || node.type === "JSXSpreadChild";
}

function isKeyedFalse(attribute: Node): boolean {
  if (attribute.type !== "JSXAttribute") return false;
  if (attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "keyed") return false;
  const value = attribute.value;
  return value?.type === "JSXExpressionContainer" && value.expression.type === "Literal" && value.expression.value === false;
}

/** The item accessor's name when `fn` is the child callback of a `<For keyed={false}>`, else null. */
function positionItemName(fn: Node): string | null {
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression") return null;
  const container = fn.parent;
  if (container?.type !== "JSXExpressionContainer" || container.expression !== fn) return null;
  const element = container.parent;
  if (element?.type !== "JSXElement") return null;
  const name = element.openingElement.name;
  if (name.type !== "JSXIdentifier" || name.name !== "For") return null;
  if (!element.openingElement.attributes.some(isKeyedFalse)) return null;
  const item = fn.params[0];
  return item?.type === "Identifier" ? item.name : null;
}

/**
 * Solid 2's `<For keyed={false}>` runs its child callback once per position and hands it the item as an
 * accessor. The callback body is an owner, not a tracking scope: a call of the accessor there (a ternary's
 * test, a `const v = item()`) is read once and stays the first item's while the position shows others.
 */
export const noOncePerPositionReadRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading a <For keyed={false}> item accessor at the top of its callback, where it is read once per position and goes stale.",
    },
    messages: {
      oncePerPosition:
        "This reads the item once per position and keeps that value when the position shows another item. Read it reactively: wrap the choice in <Show>/<Switch> or move it into a {…} in the returned JSX (or an attribute, or a memo).",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.arguments.length > 0) return;
        const accessor = node.callee.name;
        let current: Node | null = node.parent;
        while (current !== null) {
          if (isReactivePlace(current)) return;
          if (isFunction(current)) {
            if (positionItemName(current) === accessor) context.report({ node, messageId: "oncePerPosition" });
            return;
          }
          current = current.parent;
        }
      },
    };
  },
});
