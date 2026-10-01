/**
 * The skills a fleet's session can be told to run by name (`/<name> [args]`), read from disk as Claude
 * Code reads them: this plugin's own, every other installed and enabled plugin's (`<plugin>:<skill>`),
 * the user's (`~/.claude/skills`, `~/.claude/commands`) and the project's (`.claude/skills`,
 * `.claude/commands` in the fleet's repository, from where its session started up to the repository
 * root). Only the YAML frontmatter of each file is read, by a reader for its scalar keys.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import * as Option from "effect/Option";

import { exists, isDir, listDir, resolvePath, SKILL_DIR } from "../files.ts";
import { asArray, asObject, asString, parseObject, type Json, type JsonObject } from "../json.ts";
import { readObject } from "../registry.ts";
import { transcriptOf } from "../transcripts.ts";

/** Where a skill comes from. */
export type SkillSource = "plugin" | "user" | "project";

/** One skill the user can type. */
export interface Skill {
  /** What follows the `/`: `plugin:skill` for a plugin's, the bare name otherwise. */
  readonly name: string;
  readonly description: string;
  /** Its `argument-hint`, or empty. */
  readonly hint: string;
  readonly source: SkillSource;
  /** Whether the model may invoke it on its own (not `disable-model-invocation`). */
  readonly model: boolean;
}

/** Where the skills are read from. */
export interface SkillPlaces {
  /** Claude Code's config directory (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). */
  readonly config: string;
  /** This plugin's root (its `.claude-plugin/plugin.json`). */
  readonly plugin: string;
  /** The directory the fleet's session started in, when known. */
  readonly repo: string | undefined;
}

/** This plugin's root, the checkout the fleet runs from. */
export const PLUGIN_ROOT = resolve(SKILL_DIR, "..", "..", "..");

/** How much of a file is read for its frontmatter. */
const HEAD_BYTES = 16 * 1024;

/** How much of a transcript is read for the directory its session started in. */
const TRANSCRIPT_HEAD_BYTES = 256 * 1024;

/** A name Claude Code takes from the frontmatter; any other falls back to the directory's. */
const VALID_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function head(path: string, bytes: number): string | undefined {
  let fd: number | undefined;

  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(bytes);
    const got = readSync(fd, buffer, 0, bytes, 0);

    return buffer.subarray(0, got).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, (_all, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");

  return value.replace(/\s+#.*$/, "");
}

function block(lines: readonly string[], style: string): string {
  const indents = lines.flatMap((l) => (l.trim() === "" ? [] : [l.length - l.trimStart().length]));
  const cut = indents.length === 0 ? 0 : Math.min(...indents);
  const body = lines.map((l) => l.slice(cut));

  if (style.startsWith("|")) return body.join("\n").trim();

  return body
    .join("\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split("\n").join(" ").trim())
    .join("\n")
    .trim();
}

/** The top-level scalar keys of a Markdown file's YAML frontmatter (`---` … `---`); lists and maps are skipped. */
export function frontmatter(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);

  if (lines[0]?.trim() !== "---") return fields;
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));

  if (end < 0) return fields;
  const inner = lines.slice(1, end);

  for (let i = 0; i < inner.length; i += 1) {
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(inner[i] ?? "");

    if (m === null) continue;
    const key = m[1] ?? "";
    const value = (m[2] ?? "").trim();
    let next = i + 1;

    while (next < inner.length && (inner[next]?.trim() === "" || /^\s/.test(inner[next] ?? ""))) next += 1;
    const more = inner.slice(i + 1, next);
    i = next - 1;

    if (/^[>|][-+]?$/.test(value)) fields.set(key, block(more, value));
    else if (value !== "" && !value.startsWith("[") && !value.startsWith("{")) {
      const rest = more.map((l) => l.trim()).filter((l) => l !== "");

      fields.set(key, unquote([value, ...rest].join(" ")));
    }
  }

  return fields;
}

function skillOf(file: string | undefined, content: string | undefined, dirName: string, source: SkillSource, prefix: string, named: boolean): Skill | undefined {
  const text = file === undefined ? content : head(file, HEAD_BYTES);

  if (text === undefined) return undefined;
  const fields = frontmatter(text);

  if (fields.get("user-invocable")?.toLowerCase() === "false") return undefined;
  const given = named ? fields.get("name") : undefined;
  const name = given !== undefined && VALID_NAME.test(given) ? given : dirName;

  return {
    name: `${prefix}${name}`,
    description: fields.get("description") ?? "",
    hint: fields.get("argument-hint") ?? "",
    source,
    model: fields.get("disable-model-invocation")?.toLowerCase() !== "true",
  };
}

/** The skills under `path`: itself when it holds a SKILL.md, else each `<dir>/SKILL.md` in it. */
function skillsIn(path: string, source: SkillSource, prefix: string): Skill[] {
  if (exists(join(path, "SKILL.md"))) {
    const one = skillOf(join(path, "SKILL.md"), undefined, basename(path), source, prefix, true);

    return one === undefined ? [] : [one];
  }

  return listDir(path).flatMap((name) => {
    const file = join(path, name, "SKILL.md");
    const one = exists(file) ? skillOf(file, undefined, name, source, prefix, true) : undefined;

    return one === undefined ? [] : [one];
  });
}

/** The commands under `path`: itself when it is a `.md` file, else each `*.md` in it. */
function commandsIn(path: string, source: SkillSource, prefix: string): Skill[] {
  const files = isDir(path) ? listDir(path).flatMap((n) => (n.endsWith(".md") ? [join(path, n)] : [])) : path.endsWith(".md") ? [path] : [];

  return files.flatMap((file) => {
    const one = isDir(file) ? undefined : skillOf(file, undefined, basename(file, ".md"), source, prefix, false);

    return one === undefined ? [] : [one];
  });
}

function paths(value: Json | undefined): string[] {
  const one = asString(value);

  if (one !== undefined) return [one];

  return (asArray(value) ?? []).flatMap((v) => {
    const s = asString(v);

    return s === undefined ? [] : [s];
  });
}

/** A plugin's skills and commands, each named `<plugin>:<name>`. */
function pluginSkills(root: string, manifest: JsonObject | undefined, name: string): Skill[] {
  const prefix = `${name}:`;
  const skillDirs = [...new Set([join(root, "skills"), ...paths(manifest?.["skills"]).map((p) => resolve(root, p))])];
  const skills = skillDirs.flatMap((dir) => skillsIn(dir, "plugin", prefix));
  const given = manifest?.["commands"];
  const map = asObject(given);

  if (map !== undefined) {
    const mapped = Object.entries(map).flatMap(([command, spec]) => {
      const source = asString(asObject(spec)?.["source"]);
      const one = skillOf(source === undefined ? undefined : resolve(root, source), asString(asObject(spec)?.["content"]), command, "plugin", prefix, false);

      return one === undefined ? [] : [one];
    });

    return [...skills, ...mapped];
  }

  const commandPaths = given === undefined ? [join(root, "commands")] : paths(given).map((p) => resolve(root, p));

  return [...skills, ...commandPaths.flatMap((p) => commandsIn(p, "plugin", prefix))];
}

/** `enabledPlugins` of the user's settings, then the project's and its local settings, the later winning. */
function enabledPlugins(places: SkillPlaces): Map<string, boolean> {
  const files = [join(places.config, "settings.json")];

  if (places.repo !== undefined) files.push(join(places.repo, ".claude", "settings.json"), join(places.repo, ".claude", "settings.local.json"));
  const enabled = new Map<string, boolean>();

  for (const file of files) {
    for (const [key, value] of Object.entries(asObject(readObject(file)?.["enabledPlugins"]) ?? {})) {
      if (value === true || value === false) enabled.set(key, value);
    }
  }

  return enabled;
}

/** Every installed plugin that is enabled for the fleet's repository, but `skip`, with its skills. */
function installedSkills(places: SkillPlaces, skip: string): Skill[] {
  const installed = asObject(readObject(join(places.config, "plugins", "installed_plugins.json"))?.["plugins"]) ?? {};
  const enabled = enabledPlugins(places);
  const repo = places.repo === undefined ? undefined : resolvePath(places.repo);

  return Object.entries(installed).flatMap(([key, installs]) => {
    const install = (asArray(installs) ?? []).map(asObject).find((i) => {
      const scope = asString(i?.["scope"]);
      const project = asString(i?.["projectPath"]);

      return scope === "project" || scope === "local" ? project !== undefined && repo !== undefined && resolvePath(project) === repo : i !== undefined;
    });

    const root = asString(install?.["installPath"]);

    if (root === undefined) return [];
    const manifest = readObject(join(root, ".claude-plugin", "plugin.json"));
    const name = asString(manifest?.["name"]) ?? key.split("@")[0] ?? key;

    if (name === skip || !(enabled.get(key) ?? manifest?.["defaultEnabled"] !== false)) return [];

    return pluginSkills(root, manifest, name);
  });
}

/** `start` and each parent up to the repository root (`.jj` or `.git`); `start` alone outside a repository. */
function projectDirs(start: string): string[] {
  const dirs: string[] = [];

  for (let at = resolvePath(start); ; at = dirname(at)) {
    dirs.push(at);

    if (exists(join(at, ".jj")) || exists(join(at, ".git"))) return dirs;

    if (dirname(at) === at) return [resolvePath(start)];
  }
}

/**
 * The skills the user can type in the fleet's session, sorted by name. Plugins' are namespaced and never
 * collide; of two bare names the first read wins: the user's before the project's (Claude Code runs the
 * personal skill over the project's), a skill before a command, the nearer project directory first.
 */
export function readSkills(places: SkillPlaces): Skill[] {
  const manifest = readObject(join(places.plugin, ".claude-plugin", "plugin.json"));
  const own = asString(manifest?.["name"]) ?? basename(places.plugin);
  const projects = places.repo === undefined ? [] : projectDirs(places.repo);

  const all = [
    ...pluginSkills(places.plugin, manifest, own),
    ...installedSkills(places, own),
    ...skillsIn(join(places.config, "skills"), "user", ""),
    ...commandsIn(join(places.config, "commands"), "user", ""),
    ...projects.flatMap((dir) => skillsIn(join(dir, ".claude", "skills"), "project", "")),
    ...projects.flatMap((dir) => commandsIn(join(dir, ".claude", "commands"), "project", "")),
  ];

  const seen = new Map<string, Skill>();

  for (const skill of all) if (!seen.has(skill.name)) seen.set(skill.name, skill);

  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The directory the fleet at `root` works in: where its session started (the first `cwd` its transcript
 * records), else the repository of the ledger's first workspace; undefined when neither says.
 */
export function repoOf(root: string, config: string): string | undefined {
  const transcript = transcriptOf(root, config);
  const text = transcript === undefined ? undefined : head(transcript, TRANSCRIPT_HEAD_BYTES);

  for (const line of (text ?? "").split("\n")) {
    const cwd = asString(Option.getOrUndefined(parseObject(line))?.["cwd"]);

    if (cwd !== undefined && cwd !== "") return cwd;
  }

  const workspaces = asArray(readObject(join(root, "state.json"))?.["workspaces"]) ?? [];

  for (const row of workspaces) {
    const repo = asString(asObject(row)?.["repo"]);

    if (repo !== undefined && repo !== "") return repo;
  }

  return undefined;
}
