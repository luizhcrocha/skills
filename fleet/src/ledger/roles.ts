/**
 * The role table: which (model, effort) pairs the policy approves, and the model and effort a new worker
 * takes by its skill. Its values live here and nowhere else in the TypeScript fleet; state.py's `ROLES` is
 * its Python twin, which the oracle's model reads, so a new table is one edit in each and re-recorded traces.
 */

/** The thinking efforts a worker can be spawned at. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

interface RoleTable {
  /** The efforts the policy approves on each model, in the order the warnings name them. Any other model,
   * or any other pair, is the user's to approve, case by case (L3). */
  readonly pairs: Readonly<Record<string, readonly string[]>>;
  /** A new worker's model and effort by its skill, when `--model` or `--effort` is not given; `""` is any other
   * skill, and `advisor` is `fleet advisor`'s row (whose skill is none). */
  readonly kinds: Readonly<Record<string, readonly [model: string, effort: string]>>;
  /** The effort a model given without `--effort` takes when its kind's is not among its pairs. */
  readonly alone: Readonly<Record<string, string>>;
}

/** The role table (see the module comment). */
export const ROLES: RoleTable = {
  pairs: { opus: ["medium", "high"], sonnet: ["low", "medium", "high"], fable: ["high", "xhigh"] },
  kinds: { research: ["sonnet", "medium"], advisor: ["fable", "high"], "": ["opus", "high"] },
  alone: { opus: "high", sonnet: "medium", fable: "high" },
};

/** The worker models the policy approves; any other is the user's to approve, case by case (L3). */
export const POLICY_MODELS: readonly string[] = Object.keys(ROLES.pairs);

/** The model and the effort a worker is spawned on. */
export interface Role {
  readonly model: string;
  readonly effort: string;
}

/** A new worker's model and effort: the ones given, else its kind's. A model given without an effort takes its
 * kind's effort when the pair is in the policy, else the model's own (`alone`), else its kind's still. */
export function roleDefaults(skill: string, model: string | undefined, effort: string | undefined): Role {
  const [kindModel, kindEffort] = ROLES.kinds[skill] ?? ROLES.kinds[""] ?? ["opus", "high"];

  if (effort !== undefined && effort !== "") return { model: model !== undefined && model !== "" ? model : kindModel, effort };

  if (model === undefined || model === "") return { model: kindModel, effort: kindEffort };

  if (ROLES.pairs[model]?.includes(kindEffort) === true) return { model, effort: kindEffort };

  return { model, effort: ROLES.alone[model] ?? kindEffort };
}

/** What `agent` says when the worker `id` it gave a model or an effort is now outside the policy: accepted,
 * and the user's to approve before it is spawned so. A row with no effort (from before it was recorded) is
 * judged by its model alone. */
export function offPolicy(id: string, model: string, effort: string | undefined): string | undefined {
  const efforts = ROLES.pairs[model];

  if (efforts === undefined) {
    return `state: ${id} is recorded on ${model}, outside the model policy (${POLICY_MODELS.join(", ")}): spawning it on ${model} needs the user's OK.`;
  }

  if (effort === undefined || effort === "" || efforts.includes(effort)) return undefined;

  const pairs = Object.entries(ROLES.pairs)
    .map(([m, e]) => `${m} ${e.join(", ")}`)
    .join("; ");

  return `state: ${id} is recorded on ${model} at ${effort} effort, outside the effort policy (${pairs}): spawning it so needs the user's OK.`;
}
