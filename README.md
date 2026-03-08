# Production Schedule Reflow (Technical Test)

This project is a backend scheduler that **reflows work orders** when something changes (delay, conflict, maintenance, etc).

The goal is to produce a valid updated schedule while respecting hard constraints.

## What this solves

Given a list of work orders and work centers, the scheduler updates start/end times so that:

- dependencies are respected (`parent` must finish before `child` starts)
- one work center does only one job at a time (no overlap)
- work runs only inside shift hours
- work pauses during maintenance windows
- maintenance work orders marked as fixed are not moved

## Tech stack

- TypeScript
- Luxon (date/time handling in UTC)
- Vitest (automated tests)

## Project structure

- `src/reflow/reflow.service.ts`: main scheduling algorithm
- `src/utils/date-utils.ts`: shift/maintenance time math helpers
- `src/reflow/types.ts`: core data types
- `src/reflow/constraint-checker.ts`: extra validation helpers
- `src/sample-data/scenarios.ts`: runnable demo scenarios
- `src/index.ts`: demo runner
- `tests/reflow.service.test.ts`: core behavior tests
- `tests/reflow.edge-cases.test.ts`: edge-case/failure tests

## Setup

```bash
npm install
```

## Run demo

```bash
npm run demo
```

This prints for each scenario:

- original schedule
- updated schedule
- changes
- reason(s) for each change
- explanation summary

## Run tests

```bash
npm test
```

Also recommended:

```bash
npm run typecheck
```

## Input model (simple)

### Work Order
A schedulable job with:

- `workCenterId`
- `startDate`, `endDate`
- `durationMinutes` (working time)
- `dependsOnWorkOrderIds`
- `isMaintenance`

### Work Center
A machine/line with:

- shift calendar (`dayOfWeek`, `startHour`, `endHour`)
- maintenance windows (`startDate`, `endDate`)

## Algorithm approach (high-level)

For each work order (in dependency-safe order):

1. start from original start date
2. push start later if parent dependencies finish later
3. push start later if machine is currently busy
4. move start to next valid working instant (shift + maintenance aware)
5. compute end date by consuming only working minutes
6. if the full interval still overlaps machine reservations, push and retry
7. reserve interval and save reasons for changes

Finally, return:

- `updatedWorkOrders`
- `changes`
- `explanation`

## Scenarios included

1. **Delay Cascade**
- dependency chain pushes downstream jobs

2. **Shift Boundary**
- work starts late, pauses at shift end, resumes next shift

3. **Maintenance Conflict**
- work pauses during maintenance window

4. **Circular Dependency (Expected Error)**
- validates failure for cyclic dependency graph

## Automated test coverage

### Core behavior tests (`reflow.service.test.ts`)

- dependency + maintenance delay cascade
- shift boundary pause/resume
- maintenance pause behavior
- overlap resolution
- circular dependency error

### Edge-case tests (`reflow.edge-cases.test.ts`)

- missing dependency ID
- unknown work center
- negative duration
- fixed maintenance violating dependency timing
- larger circular dependency cycle

## Notes and trade-offs

- All date calculations are done in **UTC**.
- Focus is correctness and clarity first.
- Current approach is greedy/earliest-valid-start scheduling (good for this test scope).
- It does not optimize for best global objective (for example, minimizing total delay across all possible plans).

## Known limitations

- No setup-time support yet (`setupTimeMinutes` bonus not added).
- No advanced optimization metrics (utilization/idle-time dashboard).
- Demo output is console-based (no UI).

## Future improvements

- Add `setupTimeMinutes` into effective duration calculation.
- Add schedule optimization metrics.
- Add more property-based/randomized tests.
- Add a small API wrapper (`POST /reflow`) for real integration.
