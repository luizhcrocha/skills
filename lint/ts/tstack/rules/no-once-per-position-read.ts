import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type Node = ESTree.Node;

type Frozen = { readonly name: string; readonly what: string };

function isFunction(node: Node): boolean {
  return node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration";
}

/** Places Solid's compiler reads lazily: a `{…}` child, an attribute, a spread. */
function isReactivePlace(node: Node): boolean {
  return node.type === "JSXExpressionContainer" || node.type === "JSXAttribute" || node.type === "JSXSpreadAttribute" || node.type === "JSXSpreadChild";
}

/** The `keyed` attribute: absent, `false`, `true` (bare or `{true}`), or anything else (a key function). */
function keyedOf(element: ESTree.JSXElement): "absent" | "false" | "true" | "other" {
  for (const attribute of element.openingElement.attributes) {
    if (attribute.type !== "JSXAttribute") continue;
    if (attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "keyed") continue;
    const value = attribute.value;
    if (value === null) return "true";
    if (value.type === "JSXExpressionContainer" && value.expression.type === "Literal") {
      if (value.expression.value === false) return "false";
      if (value.expression.value === true) return "true";
    }
    return "other";
  }
  return "absent";
}

/**
 * The accessor parameters of `fn` that freeze when read at the top of its body, when `fn` is the function
 * child of a Solid 2 flow component (solid-js 2.0.0-rc.13, flow.d.ts and dist/solid.js):
 * - `<For keyed={false}>`: the item, an accessor (the index is a number).
 * - `<For>` keyed by identity or by a key function: the index, an accessor of the row's place, updated when
 *   the row moves. A key function's item is an accessor too but is left alone: the key usually holds what
 *   the callback reads.
 * - `<Show>` and `<Match>` without `keyed`: the narrowed value, an accessor; the callback runs untracked
 *   and again only when `when` turns falsy and truthy, not when it changes from one truthy value to another.
 */
function frozenAccessors(fn: Node): readonly Frozen[] {
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression") return [];
  const container = fn.parent;
  if (container?.type !== "JSXExpressionContainer" || container.expression !== fn) return [];
  const element = container.parent;
  if (element?.type !== "JSXElement") return [];
  const tag = element.openingElement.name;
  if (tag.type !== "JSXIdentifier") return [];
  const keyed = keyedOf(element);
  const found = (index: number, what: string): readonly Frozen[] => {
    const param = fn.params[index];
    return param?.type === "Identifier" ? [{ name: param.name, what }] : [];
  };

  if (tag.name === "For") return keyed === "false" ? found(0, "the item") : found(1, "the index");
  if (tag.name === "Show" || tag.name === "Match") return keyed === "absent" || keyed === "false" ? found(0, "the narrowed value") : [];
  return [];
}

/**
 * Solid 2's flow components run a function child once and hand it accessors: <For keyed={false}>'s item,
 * <For>'s index, <Show>/<Match>'s narrowed value. The callback body is an owner, not a tracking scope: a
 * call of the accessor there (a ternary's test, a `const v = item()`) is read once and keeps that value
 * while the accessor moves on.
 */
export const noOncePerPositionReadRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading a Solid flow callback's accessor (<For> item or index, <Show>/<Match> value) at the top of the callback, where it is read once and goes stale.",
    },
    messages: {
      oncePerPosition:
        "This reads {{what}} once, when the callback runs, and keeps that value when it changes. Read it reactively: wrap the choice in <Show>/<Switch> or move it into a {…} in the returned JSX (or an attribute, or a memo).",
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
            const frozen = frozenAccessors(current).find((f) => f.name === accessor);
            if (frozen !== undefined) context.report({ node, messageId: "oncePerPosition", data: { what: frozen.what } });
            return;
          }
          current = current.parent;
        }
      },
    };
  },
});
