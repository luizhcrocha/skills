/**
 * The reaper's containers: a Docker container's processes hang off containerd-shim, not off the agent that ran
 * `docker compose up`, so no process tree names its owner. Its compose `working_dir` label does: the workspace it sits
 * in. A pure core over the containers a {@link ContainerRow} list reads; reaper-read.ts reads them and stops them.
 * Only a container whose workspace folder is gone is reaped, by `docker stop` then `docker rm` with its volumes kept, so
 * `docker compose up` brings it back with its data; anything else is reported.
 */
import { DEFAULT_MIN_HOURS } from "./orphans.ts";

/** Where a container's compose project sits, as the reader found it on disk. */
export type Place =
  /** No `com.docker.compose.project.working_dir` label: nothing says whose it is. */
  | { readonly kind: "unlabeled" }
  /** The label's folder is gone. */
  | { readonly kind: "gone"; readonly dir: string }
  /** The folder, or the workspace that held it, is there; `workspace` undefined when no jj or git checkout holds it,
   * or the container's processes are not on this machine (a remote daemon, a VM). */
  | { readonly kind: "present"; readonly dir: string; readonly workspace: string | undefined };

/** One running container as the reader saw it. */
export interface ContainerRow {
  /** The full id: `docker stop` and `docker rm` take it, and no other container has it. */
  readonly id: string;
  readonly name: string;
  /** When it started, epoch seconds. */
  readonly started: number;
  /** Its cgroup's memory less inactive file pages, in bytes, as `docker stats` counts it; 0 with no reading. */
  readonly rss: number;
  readonly place: Place;
}

/** The decision for a container, encoded so a stop can only take a `reap`. */
export type ContainerVerdict =
  | { readonly kind: "reap"; readonly why: { readonly ageS: number; readonly rss: number } }
  | { readonly kind: "ask"; readonly why: "owner live" | "owner unknown" | "owner gone, workspace present" | "no compose label" }
  | { readonly kind: "skip"; readonly why: "small" | "young" };

export interface JudgedContainer {
  /** Stable while the same container runs: `container-<name>:<id prefix>:<started>`. */
  readonly key: string;
  readonly container: ContainerRow;
  /** Whether a live Claude works where the container's project sits. */
  readonly live: boolean;
  /** Seconds since it started. */
  readonly ageS: number;
  readonly verdict: ContainerVerdict;
}

/** How long a container of a dead owner in a present workspace runs before it is reported, as an orphaned tree. */
const REPORT_AGE_S = DEFAULT_MIN_HOURS * 3600;

function verdictOf(c: ContainerRow, live: boolean, t: { readonly minRss: number; readonly idleS: number }, ageS: number): ContainerVerdict {
  if (c.place.kind === "gone") {
    if (live) return { kind: "ask", why: "owner live" };

    return ageS < t.idleS ? { kind: "skip", why: "young" } : { kind: "reap", why: { ageS, rss: c.rss } };
  }

  if (c.rss < t.minRss) return { kind: "skip", why: "small" };

  if (c.place.kind === "unlabeled") return { kind: "ask", why: "no compose label" };

  if (live) return { kind: "ask", why: "owner live" };

  if (c.place.workspace === undefined) return { kind: "ask", why: "owner unknown" };

  return ageS < REPORT_AGE_S ? { kind: "skip", why: "young" } : { kind: "ask", why: "owner gone, workspace present" };
}

/** Pure. Each container's verdict: its folder gone, idle past `t.idleS` and no live Claude there, reap, whatever its
 * size; else, at `t.minRss` or more, ask (unlabeled, a live owner, an unknown one, or a dead one past
 * {@link DEFAULT_MIN_HOURS}); else skip. `livesAt` says whether a live Claude works at a path. */
export function judgeContainers(containers: readonly ContainerRow[], livesAt: (path: string) => boolean, t: { readonly minRss: number; readonly idleS: number }, now: number): JudgedContainer[] {
  return containers.map((container) => {
    const place = container.place;
    const live = place.kind === "unlabeled" ? false : livesAt(place.kind === "present" ? place.workspace ?? place.dir : place.dir);

    const ageS = Math.max(0, now - container.started);

    return { key: `container-${container.name}:${container.id.slice(0, 12)}:${String(container.started)}`, container, live, ageS, verdict: verdictOf(container, live, t, ageS) };
  });
}

/** What a stop may touch: a `reap` container. Nothing else makes one. */
export class ContainerKillable {
  readonly judged: JudgedContainer;

  private constructor(judged: JudgedContainer) {
    this.judged = judged;
  }

  static ofReap(j: JudgedContainer): ContainerKillable | undefined {
    return j.verdict.kind === "reap" ? new ContainerKillable(j) : undefined;
  }
}

/** `docker stop` and `docker rm` of one container by its full id, as the shell provides them; each says whether it worked. */
export interface ContainerIo {
  readonly stop: (id: string) => boolean;
  readonly remove: (id: string) => boolean;
}

/** The containers' owner as a report prints it. */
export function containerOwnerText(j: JudgedContainer): string {
  const place = j.container.place;

  switch (place.kind) {
    case "unlabeled": return "no compose label";
    case "gone": return j.live ? "workspace gone (live)" : "workspace gone";
    case "present": return place.workspace === undefined ? "owner unknown" : j.live ? "workspace live" : "owner gone (workspace present)";
  }
}

/** Where a report says the container sits: its workspace, else its compose folder. */
export function containerWhere(c: ContainerRow): string | undefined {
  switch (c.place.kind) {
    case "unlabeled": return undefined;
    case "gone": return c.place.dir;
    case "present": return c.place.workspace ?? c.place.dir;
  }
}
