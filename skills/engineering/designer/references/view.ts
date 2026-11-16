const L: Record<string,string> = {
  found: "Origin agent finds complex work", proposed: "Spin-off proposed to Luiz",
  designing: "Designer researches and models", designReview: "Gate 1: design out for review",
  planReview: "Gate 2: lane plan out for review", fleetCheck: "Checking names and overlap in fleet",
  parked: "Parked: fleet unavailable", teamReview: "Gate 3: team out for review",
  ready: "All three approved on record", handed: "Coordinators own it", dropped: "Dropped",
};
export const title = "spin-off: from found work to a running fleet";
export const state = (v: any) => L[v.phase];
export const group = (v: any) =>
  ["found","proposed"].includes(v.phase) ? "origin" : v.phase === "handed" ? "fleet" : v.phase === "dropped" ? "end"
  : v.phase.endsWith("Review") ? "review" : "designer";
export const colors = { origin: "blue", designer: "purple", review: "orange", fleet: "teal", end: "tan" };
export const step = (a: string, f: any, t: any) => (a === "ChangeDesign" && f.phase !== "designReview") || (a === "ChangePlan" && f.phase !== "planReview") ? null : ({
  Propose: "the agent proposes a spin-off", Decline: "Luiz says no", Spin: "Luiz says yes; a tab opens",
  PublishDesign: "the designer publishes artifacts", ChangeDesign: "the design changes; later approvals void",
  ApproveDesign: "Luiz approves the design", ChangePlan: "the plan changes; team approval voids",
  ApprovePlan: "Luiz approves the plan", FleetOK: "fleet is up; no clash", FleetDown: "fleet is unavailable",
  FleetFlip: null, Unpark: "fleet is back", ChangeTeam: "the team changes; its approval voids and the fleet check reruns", ApproveTeam: "Luiz approves the team",
  Drop: null, Launch: "the designer runs fleet team add per coordinator",
  LaunchFleetDown: "fleet went down before launch", Resume: "the designer resumes from the record", Done: null,
} as any)[a];
