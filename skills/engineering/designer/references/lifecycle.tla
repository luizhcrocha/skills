---- MODULE lifecycle ----
EXTENDS Integers
\* dv, pv, sv count from 0: the record's v1 is 0 here.
\* pub: the current design version's page is published. checked: a fleet check passed on the current design, plan and team.
VARIABLES phase, dv, pv, sv, dOK, pOK, sOK, fleetUp, launched, pub, checked
vars == <<phase, dv, pv, sv, dOK, pOK, sOK, fleetUp, launched, pub, checked>>
Max == 1
None == -1
Init == phase = "found" /\ dv = 0 /\ pv = 0 /\ sv = 0 /\ dOK = None /\ pOK = None /\ sOK = None
        /\ fleetUp \in BOOLEAN /\ launched = FALSE /\ pub = FALSE /\ checked = FALSE
Live == phase \in {"designing","designReview","planReview","fleetCheck","parked","teamReview","ready"}
Go(p) == phase' = p
Propose == phase = "found" /\ Go("proposed") /\ UNCHANGED <<dv,pv,sv,dOK,pOK,sOK,fleetUp,launched,pub,checked>>
Decline == phase = "proposed" /\ Go("dropped") /\ UNCHANGED <<dv,pv,sv,dOK,pOK,sOK,fleetUp,launched,pub,checked>>
Spin    == phase = "proposed" /\ Go("designing") /\ UNCHANGED <<dv,pv,sv,dOK,pOK,sOK,fleetUp,launched,pub,checked>>
PublishDesign == phase = "designing" /\ pub' = TRUE /\ Go("designReview") /\ UNCHANGED <<dv,pv,sv,dOK,pOK,sOK,fleetUp,launched,checked>>
\* A design change voids every later approval in the record and the fleet check.
ChangeDesign == phase \in {"designReview","planReview","fleetCheck","parked","teamReview","ready"} /\ dv < Max
   /\ dv' = dv + 1 /\ dOK' = None /\ pOK' = None /\ sOK' = None /\ pub' = FALSE /\ checked' = FALSE /\ Go("designing")
   /\ UNCHANGED <<pv,sv,fleetUp,launched>>
ApproveDesign == phase = "designReview" /\ dOK' = dv /\ Go("planReview") /\ UNCHANGED <<dv,pv,sv,pOK,sOK,fleetUp,launched,pub,checked>>
ChangePlan == phase \in {"planReview","fleetCheck","parked","teamReview","ready"} /\ pv < Max /\ pv' = pv + 1
   /\ pOK' = None /\ sOK' = None /\ checked' = FALSE /\ Go("planReview") /\ UNCHANGED <<dv,sv,dOK,fleetUp,launched,pub>>
ApprovePlan == phase = "planReview" /\ pOK' = pv /\ Go("fleetCheck") /\ UNCHANGED <<dv,pv,sv,dOK,sOK,fleetUp,launched,pub,checked>>
FleetOK   == phase = "fleetCheck" /\ fleetUp /\ checked' = TRUE /\ Go("teamReview") /\ UNCHANGED <<dv,pv,sv,dOK,pOK,sOK,fleetUp,launched,pub>>
FleetDown == phase = "fleetCheck" /\ ~fleetUp /\ Go("parked") /\ UNCHANGED <<dv,pv,sv,dOK,pOK,sOK,fleetUp,launched,pub,checked>>
FleetFlip == fleetUp' = ~fleetUp /\ UNCHANGED <<phase,dv,pv,sv,dOK,pOK,sOK,launched,pub,checked>>
Unpark == phase = "parked" /\ fleetUp /\ Go("fleetCheck") /\ UNCHANGED <<dv,pv,sv,dOK,pOK,sOK,fleetUp,launched,pub,checked>>
\* A team change goes back through the fleet check before gate 3.
ChangeTeam == phase \in {"teamReview","ready"} /\ sv < Max /\ sv' = sv + 1 /\ sOK' = None /\ checked' = FALSE /\ Go("fleetCheck")
   /\ UNCHANGED <<dv,pv,dOK,pOK,fleetUp,launched,pub>>
ApproveTeam == phase = "teamReview" /\ sOK' = sv /\ Go("ready") /\ UNCHANGED <<dv,pv,sv,dOK,pOK,fleetUp,launched,pub,checked>>
Drop == Live /\ Go("dropped") /\ UNCHANGED <<dv,pv,sv,dOK,pOK,sOK,fleetUp,launched,pub,checked>>
\* Launch decides from the record alone, never from memory.
RecordApproved == dOK = dv /\ pOK = pv /\ sOK = sv
Launch == phase = "ready" /\ RecordApproved /\ fleetUp /\ launched' = TRUE /\ Go("handed")
   /\ UNCHANGED <<dv,pv,sv,dOK,pOK,sOK,fleetUp,pub,checked>>
LaunchFleetDown == phase = "ready" /\ ~fleetUp /\ Go("parked") /\ UNCHANGED <<dv,pv,sv,dOK,pOK,sOK,fleetUp,launched,pub,checked>>
\* Compaction or resume: the phase is re-derived from the record; the fleet check is memory, so it is lost.
Derive == IF dOK # dv THEN (IF pub THEN "designReview" ELSE "designing")
          ELSE IF pOK # pv THEN "planReview"
          ELSE IF sOK # sv THEN "fleetCheck" ELSE "ready"
Resume == Live /\ phase # "parked" /\ Go(Derive) /\ checked' = FALSE /\ UNCHANGED <<dv,pv,sv,dOK,pOK,sOK,fleetUp,launched,pub>>
Done == phase \in {"handed","dropped"} /\ UNCHANGED vars
Next == Propose \/ Decline \/ Spin \/ PublishDesign \/ ChangeDesign \/ ApproveDesign \/ ChangePlan
  \/ ApprovePlan \/ FleetOK \/ FleetDown \/ FleetFlip \/ Unpark \/ ChangeTeam \/ ApproveTeam \/ Drop
  \/ Launch \/ LaunchFleetDown \/ Resume \/ Done
LaunchOnlyAllApproved == launched => RecordApproved
PlanApprovalNeedsDesign == pOK # None => dOK = dv
TeamApprovalNeedsPlan == sOK # None => pOK = pv
TeamReviewedOnlyWithFleet == phase = "teamReview" => checked /\ pOK = pv /\ dOK = dv
====
