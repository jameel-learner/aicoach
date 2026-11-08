# Engagement Policy & Review Checklist

Applies to **every** feature that touches attention, motivation, notifications, progress or social features (architecture §6.1, spec 5). The rule for every retention mechanic is that it **must survive the learner reading its source code** (spec 5.5.4).

Use this checklist in the review of any PR that adds or changes such a feature. A "no" on any **must** item blocks the merge.

## 1. Honesty (must)

- [ ] No manufactured urgency ("Only 2 hours left!", countdowns that aren't real exam dates).
- [ ] No fake scarcity, fake social proof or invented numbers ("1,203 students are studying now").
- [ ] No loss framing. Streaks may show *days studied*, never "you'll lose your streak".
- [ ] Progress numbers are real and explainable (what was measured, over what period).
- [ ] Marks predictions and "predicted papers" state their basis and uncertainty; never "guaranteed" or "leaked".
- [ ] Every AI claim carries a textbook citation or an explicit "not in your textbook / unsure" flag.

## 2. Respect for time & attention (must)

- [ ] Study units are 7–12 minutes and end at a natural stopping point with a visible win.
- [ ] The learner is never left mid-concept when a session ends; resume is one tap.
- [ ] Answer first; depth is opt-in and one tap away. No long preambles or forced tours.
- [ ] Notifications respect a frequency cap, quiet hours and the learner's declared study windows.
- [ ] Notifications back off automatically when ignored. No escalation.
- [ ] Every notification leads to a specific, finishable action (deep link into the right step).

## 3. No manipulative game mechanics (must)

- [ ] Allowed: levels, mastery gating, hint ladders, boss sets, retry without penalty, co-op.
- [ ] Not allowed: variable/random rewards, loot boxes, daily-login pressure, pay-to-progress.
- [ ] No public leaderboards or rankings. Progress is private by default.

## 4. Emotional safety (must)

- [ ] When overwhelm is detected, offer **scope reduction** ("just 3 questions today"), not cheerleading.
- [ ] When distress is detected, use the fixed **safety handoff** (helpline + parent alert), never an LLM pep talk.
- [ ] Copy is calm and specific. No guilt, shame or comparison with other students.

## 5. Privacy & personalisation (must)

- [ ] Personalisation uses **declared** interests, not inferred behavioural profiles.
- [ ] No behavioural advertising or third-party tracking for minors (DPDP).
- [ ] Shared artefacts (summary cards etc.) are shared only by explicit learner action.

## 6. Teacher counterpart (should)

- [ ] A learner-facing attention feature has a teacher-facing view where it makes sense (cohort dashboard, misconception roll-up).

## 7. Measurement (should)

- [ ] Success is measured as **return-to-learning** and mastery gained, not raw time-in-app or opens.

---

*Owner: product. Changes to this policy are recorded in architecture.md §9.*
