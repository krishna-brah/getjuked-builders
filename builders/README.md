# juke Builder API: Python reference kit (offline)

Run the three examples from the repository root, using Python 3.10 or newer. They need only the standard library and make no network requests:

```sh
python3 -m builders.demo --agent all
python3 -m builders.demo --agent market_follower
python3 -m builders.demo --agent counterpart_pregame
python3 -m builders.demo --agent live_score_clock
python3 -m unittest builders.test_kit
```

Every response, forecast, position and readback in the demo is labelled `SYNTHETIC_OFFLINE_ONLY`. Each agent has a separate mock Book. The client reads the summary and event board, seals its forecast, submits a paper buy with a price limit, then reads positions, the changed Book and the record. The mock record stays insufficient evidence. This proves the offline consumer flow and request shapes, not production behavior or native fills.

`client.py` implements the supplied [Builder API](../spec/BUILDER_API.md): board/SUMMARY/event queries, buy, close, forecast, positions and record. Credits and shares are canonical positive decimal strings with at most six places; `limitPrice` is numeric. Forecasts always mean probability of YES for the exact Listing. Close sends `operation: CLOSE`, the position ID and shares. The mock demo implements buys; recorded transport tests cover the close wire shape.

The API document does not specify the complete board/position response schema or offer Counterpart's private sealed directional views to builders. `fixtures.json` therefore defines an explicit normalized **synthetic input seam**, not an invented promise about the actual JSON response. The raw client returns opaque API JSON. To run an agent live, map the actual board/Book/Listing fields (see `spec/BUILDER_API.md`, or use the MCP server in `mcp/`) into this input seam with an adapter you verify yourself. Changing the fixture's synthetic flag is not that verification. Results-only model inputs belong to the builder's own model; do not extract hidden house/human views.

The agents are deliberately small:

- **Market follower:** forecast the current YES midpoint and buy the market-favored side. Crossing costs make its displayed edge negative. It is an honest reference strategy, not evidence of alpha.
- **Counterpart-style pregame:** take the builder's own causal results-only pregame probability and require the default edge at the actual accepted ask.
- **Live score/clock:** apply the retained A0 NFL winner formula to validated pre-play scores, regulation clock and that same own pregame prior. A pregame prior must already be available at the decision time, as well as precede kickoff. The unadmitted R3 candidate is not used. College, soccer, props, ET/OT and ambiguous rules produce PASS in this reference agent.

Default exposure is a 5-point edge, 25 Credits, one game action, ten weekly actions and ten open positions. A follower is explicitly exempt from the edge requirement because it illustrates copying market direction; all exposure/source guards still apply. Default model agents enforce the edge at the ask. Both quote sides, two-second quote freshness, enough ask depth, Book cash/position counts and rule identity are required. Live score receipts must be no older than 30 seconds and the quarter arithmetic must agree. These values are provisional research examples, not application settings or certified launch rules. Real native prices, rights, source identity, clocks and receipt/quote depth must be independently qualified.

Persist each decision and `orderId` **before sending it**. Reuse the identical order and body after `ORDER_IN_PROGRESS`; the helper makes at most three attempts, bounded by 30 writes/minute. After a refusal such as PRICE_MOVED, the helper stops. A later changed decision needs a new order ID; reusing a refused ID returns the old refusal. Duplicate filled orders return the first outcome and cannot be counted as a new pick. A new model version requires a new registered system; every reference agent must own its own version and Book.

An uncertain mutation (`ORDER_OUTCOME_UNKNOWN`, timeout or invalid response) reads positions and raises `ReconciliationRequired`. It blocks subsequent mutations. Empty positions alone do not prove that no order was placed. The operator must resolve the original order from the canonical response/receipt/positions before explicitly calling `confirm_reconciled(order_id, confirmed_outcome=...)`. After bounded IN_PROGRESS attempts, only the exact same pending pick/body can be resent; a new pick or forecast is held. First forecast counts; `FORECAST_ALREADY_SEALED` is not an invitation to overwrite it.

`ReplayTransport` matches an exact recorded method/path/body sequence. For additional offline cases, supply steps with `request` and `response` dictionaries. Never put real API keys in recordings. `HttpTransport` is an optional future adapter, disabled by default; no task command or test enables it. It requires an explicitly supplied key and network opt-in, restricts the documented HTTPS origin, refuses redirects, bounds response bytes/time and omits keys from its representation. This task does not call it. Owner registration/revocation and key custody remain manual authenticated owner actions; no example registers a real system.

To use the kit live, register your system on getjuked.io, keep the one-time key outside the repository, check the real board fields and verify your adapter and idempotent order readback. Local replay success does not authorize registration, a live run, source activation or model admission. The research itself stays paper-only with zero real orders/fills.
