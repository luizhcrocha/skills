// The chart follows note 1, the oldest note, which the summary does not keep, on the one machine of life.cfg.
const has = (xs: number[], x: number) => xs.includes(x);

const note = (v: any) => {
  const files: number[] = v.files.a;
  const read = v.read.a;
  if (!has(files, 1)) return "Not written yet";
  if (has(files, 101)) return "Corrected or retired: recall still finds it";
  if (has(read.notes, 1)) return "Read word for word at start";
  if (read.counts.length > 0) return "Behind a summary: counted at start, opened by zoom";
  return "Left out: the store is over budget and the count line says so";
};

export const title = "memo v2: the life of a note (a slice of 4 lines; the summary of the three oldest notes keeps another note)";
export const state = (v: any) => note(v);
export const group = (v: any) => (v.read.a.over ? "over" : "within");
export const colors = { within: "teal", over: "orange" };
export const step = (a: string, f: any, t: any) => {
  if (a === "Quiet") return null;
  if (a === "Retire")
    return t.files.a.includes(111) && !f.files.a.includes(111)
      ? "a session retires the summary"
      : "a session retires the note";
  return ({
    WriteNote:
      has(t.files.a, 1) && !has(f.files.a, 1)
        ? "a session writes the note"
        : `a session writes a newer note [${
            t.read.a.over && !f.read.a.over ? "the store goes over budget" : "a summary stands for the note"
          }]`,
    Summarize: t.files.a.includes(21) && !f.files.a.includes(21)
      ? "a session writes a higher summary"
      : "a session writes the summary of the three oldest notes",
    Supersede: "a session corrects the note with a new line",
    Sync: "notes arrive from another machine",
  } as any)[a];
};
