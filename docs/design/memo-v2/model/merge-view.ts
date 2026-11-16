// Words for the two-machine configs. The chart is drawn only for a rule that breaks (today.cfg).
const COVERS: Record<number, string> = { 10: "notes 2-3", 11: "notes 1-2", 12: "notes 3-4", 21: "notes 1-4" };
const list = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b).join(", ") : "none");
const notes = (fs: number[]) => fs.filter((x) => x < 10);
const sums = (fs: number[]) => fs.filter((x) => x >= 10 && x < 100);
const diff = (t: number[], f: number[]) => t.filter((x) => !f.includes(x));

const holds = (name: string, fs: number[]) =>
  `${name} holds notes ${list(notes(fs))}${sums(fs).length ? ` and summaries ${list(sums(fs))}` : ""}`;
const reads = (name: string, r: any) =>
  `${name} reads notes ${list(r.notes)}${
    r.counts.length ? ` and the count of ${r.counts.map((s: number) => `summary ${s} (${COVERS[s]})`).join(" and ")}` : ""
  }${r.over ? ", over budget" : ""}`;

export const title = "Two machines exchange one store's files (today's rule for the summaries in effect)";
export const state = (v: any) => `${holds("A", v.files.a)}. ${holds("B", v.files.b)}. ${reads("B", v.read.b)}`;
export const step = (a: string, f: any, t: any) => {
  if (a === "Quiet") return null;
  const m = diff(t.files.a, f.files.a).length ? "a" : "b";
  const added = diff(t.files[m], f.files[m]);
  const M = m.toUpperCase();
  if (a === "Sync") return `${M} receives the files of ${m === "a" ? "B" : "A"}`;
  if (a === "WriteNote") return `a session on ${M} writes note ${added[0]}`;
  if (a === "Summarize") return `a session on ${M} writes summary ${added[0]} of ${COVERS[added[0]]}`;
  if (a === "Supersede") return `a session on ${M} corrects note ${added.find((x) => x > 100)! - 100} with note ${added.find((x) => x < 10)}`;
  return `a session on ${M} retires ${added[0] - 100 > 9 ? "summary" : "note"} ${added[0] - 100}`;
};
