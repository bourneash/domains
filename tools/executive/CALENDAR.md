# Executive calendar

`ops/executive/calendar.json` is the checked-in source of truth for executive
follow-through events. The Fleet Manager and executive page use the same API:

- `GET /api/executive/calendar` lists events and reconciles past-due events.
- `POST /api/executive/calendar` creates an event with an ISO `at` timestamp.
- `POST /api/executive/calendar/:id/picked_up` and `/completed` record role confirmation.

The minute calendar dispatcher claims due and past-due events with a 15-minute
lease, runs only the fixed action registry in
`server/executive-calendar.js`, and commits/pushes the resulting JSON state.
Arbitrary shell scripts and user-provided arguments are rejected. State changes
are locked and audited, and a dispatched action must present its claim token to
complete. Completed events require an explicit `followup_status` of `written`
or `none`; recurring events retain the completed occurrence before advancing.
