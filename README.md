# AI Budget Enforcement POC

This folder contains a proof of concept for protecting prepaid AI credit from
overspending. It is based on
[`AI_BUDGET_ENFORCEMENT_PLAN.md`](../../../../AI_BUDGET_ENFORCEMENT_PLAN.md) and is
isolated from the production AI and billing services.

The POC demonstrates how to:

- Compare a stale-balance / concurrent-request scenario with a budget gate.
- Reserve a turn's estimated cost before generation and release unused credit
  when the turn settles or is cancelled.
- Clamp the maximum output tokens to what the remaining budget can afford.
- Reject a batch locally before it is sent to Metronome when it exceeds the
  spendable amount or the configured stop threshold.
- Price usage from a tenant's rate card in the UI flow instead of silently
  assuming that every tenant has the same rates.
- Configure credit-usage alerts and see used credit as a percentage of 100% in
  the companion UI.

> **Scope:** The budget demo and automated tests are offline. The companion UI
> server is separate and can make real Metronome API writes when you press its
> customer, contract, allowance, or event buttons. Use a sandbox API token and
> verify the configured Metronome environment before pressing those buttons.

## Requirements

- Windows PowerShell (commands below use PowerShell syntax).
- Node.js 18 or later.
- No npm packages need to be installed; the POC uses Node.js built-in modules.
- To run the companion UI, a Metronome API token with access to the required
  package, rate-card, customer, contract, commit, and ingest endpoints.

## Commands

Run these commands from the Metronome POC root:

```powershell
Set-Location 'C:\projects\pentesites\day_wise_plan\2026-10-26\metronome-poc'
```

### Run the offline budget demonstration

```powershell
node .\budget-poc\run.js
```

This prints an incident replay, compares the legacy stale-check behavior with
the guarded behavior, demonstrates token clamping and admission outcomes, and
shows how rate-card prices are mapped to usage metrics. It is deterministic and
does not call Metronome.

### Run the tests

Run the complete budget and UI-ingest-guard test set:

```powershell
npm run test:budget
```

Or run each suite separately:

```powershell
node --test .\budget-poc\budget.test.js
node --test .\budget-poc\ui-gate.test.js
```

`budget.test.js` tests the budget arithmetic, reservations, clamping, settlement,
threshold gate, and failure cases. `ui-gate.test.js` exercises the companion
server's ingest guard with Metronome stubbed; it verifies blocked batches are
not sent to the vendor and tests the user-facing top-up refusal message and
credit-alert behavior. These tests do not make real Metronome writes.

### Start the interactive token-usage UI

The UI server and page are in the parent POC folder, not in this subfolder.
Copy the budget POC's example environment file and fill in your sandbox token:

```powershell
Copy-Item .\budget-poc\.env.example .\budget-poc\.env
notepad .\budget-poc\.env
```

Set `METRONOME_API_TOKEN` in `budget-poc\.env`. `METRONOME_BASE` defaults to
`https://api.metronome.com`; use the correct environment for your token. The
folder's `.env.example` also contains the UI port and stop-threshold setting.
Alert milestones are configured per customer in the UI, not through this file.

The budget demo itself does not load `.env` files. Set its threshold directly
in PowerShell if you want to run the offline demo with a different value:

```powershell
$env:PLAN_STOP_THRESHOLD_PERCENT = '97'
node .\budget-poc\run.js
```

The demo defaults to 99% when the variable is unset. The UI server reads the
configured threshold from the `.env` file. Keep `.env` private and do not commit
it.

Tell the UI server to load the environment file and start it:

```powershell
$env:POC_ENV_FILE = (Resolve-Path .\budget-poc\.env).Path
npm run usage:ui
```

Then open <http://localhost:8792>. Stop the server with **Ctrl+C**. To use
another port, change `TOKEN_POC_PORT` in `.env` or set it in the current
PowerShell window before starting the server:

```powershell
$env:TOKEN_POC_PORT = '8793'
npm run usage:ui
```

### UI workflow

1. Create a new customer or select an existing one.
2. Select a package and assign it to the customer.
3. Grant the allowance commit, or explicitly skip it if you intend to test
   overage behavior.
4. Configure credit-usage alert milestones. Defaults are **50%, 75%, 85%, 90%,
   and 95%**; add or remove rows as needed and save them.
5. Enter input/output token counts and send usage events.
6. View the local credit-used percentage and progress bar, any triggered
   alerts, and read the rated usage back from Metronome.

The ingest budget check happens locally before the `/v1/ingest` call. A refusal
shows the percentage used and recommends a top-up; the technical refusal reason
is retained in the response details. Alerts are notifications for the POC only:
they do not change the stop threshold and do not send email or other external
notifications.

## How rates and balances work

- The offline demo and unit tests explicitly use a named rate snapshot; this is
  not an implicit runtime default.
- The interactive UI loads the selected package's rate card from Metronome and
  derives token and request prices from the associated billable metrics.
- The UI server keeps its grant, accepted-spend ledger, alert settings, and alert
  history in memory. Those values reset when the UI server restarts.
- Metronome rates ingested usage asynchronously. The UI guard therefore tracks
  accepted event cost locally so it does not rely on a delayed vendor balance
  update for its next pre-ingest decision.
- The current POC is not a production Redis deployment. `reservation-store.js`
  provides an in-memory implementation for tests/demo and includes Lua scripts
  as a reference for a Redis implementation.

## Files

| File | Purpose |
|---|---|
| `budget.js` | Cost arithmetic, prompt estimates, token clamp, threshold wall, and helpers. |
| `gate.js` | Admission, reservation/settlement, and pre-ingest batch guard. |
| `reservation-store.js` | In-memory reservation store and Redis Lua reference scripts. |
| `rate-card.js` | Maps Metronome rate-card products and metrics to explicit usage rates. |
| `run.js` | Offline incident replay and budget demonstration. |
| `.env.example` | Safe template for the companion UI's Metronome token, API base, port, and stop threshold. |
| `budget.test.js` | Offline unit tests for budget and reservation behavior. |
| `ui-gate.test.js` | UI-server ingest-guard integration tests with Metronome stubbed. |
| `../token-usage-ui-server.js` | Companion API server for the interactive UI. |
| `../public/token-usage.html` | Interactive customer, allowance, ingest, alert, and usage page. |

## Limitations

- This POC is not connected to the production AI generation path. The UI accepts
  manually entered token counts; it does not invoke an LLM or enforce
  `maxOutputTokens` on a real model call.
- The local UI ledger and alert settings are in-memory and reset on restart.
- The offline demo's named rate snapshot is for demonstration only. Use the
  selected live rate card in the UI flow when testing a package.
- The UI can create customers, assign contracts, grant allowance commits, and
  ingest events in the Metronome environment selected by its API token. Such
  writes are not undone automatically.
