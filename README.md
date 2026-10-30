# PingRoom schema mapping

Ask a named resolver which source column corresponds to each required target field, then export the complete table in that schema. Code checks one-to-one mappings and every cell's type before producing private JSON. The catalog sample never edits the source or writes to a database.

## Try it offline

Use Node.js 22 or 24 on macOS or Linux. Choose **Use this template**, clone your repository, then run:

```sh
npm ci
npm test
npm run demo
```

The demo uses the pinned SDK with a local mock transport. It covers successful mapping, a reused source column and an Unknown answer. Tests and demo need no credentials or network after installation. Live phone delivery is not tested.

## Prepare a complete table

```sh
cp examples/mapping.json mapping.json
cp config.example.json config.json
```

Edit `mapping.json` before starting. Convert your upstream CSV or database data to this JSON format; the starter does not parse CSV or connect to a database. Supply `mappingId`, `title`, 1–5 `columns` with IDs and labels, 1–50 complete `rows`, and 1–4 required `targets` with IDs, labels, `type` and `nullable`. Targets cannot outnumber sources.

Every row must contain exactly the listed source IDs. Values may be strings, safe integers, booleans or null. Strings allow empty values and meaningful outer spaces; values and row order are preserved exactly. A nullable target permits a present null cell, never a missing column or omitted mapping. Target types are exactly `string`, `integer` and `boolean`; numeric strings, decimal numbers, negative zero, nested objects and arrays are not accepted as integers or coerced into another type.

```sh
npm run validate
```

Validation is offline. Column and target arrays are sorted by ID. Keep the table, schema and labels fixed throughout a session; changes invalidate saved evidence. Answers declare semantic meaning, which type checks cannot verify. Give the resolver enough upstream context to answer or choose Unknown.

## Connect the resolver

Install [PingRoom](https://pingroom.io/i), sign in, and choose a **standard private room** containing the resolver:

```sh
npm run connect
npm run inspect
```

Open the printed pairing URL, approve the connection and grant the room. The helper prefers `pair_browser_url` and falls back to `pair_url`. Verify the intended person in the app and copy their exact room member UUID from `inspect` into `config.json` as `participant.id`. The label is descriptive; names alone do not establish identity. Keep the robot's room grant and resolver's membership active.

Pairing saves ignored `.pingroom/credentials.json` and resumes a saved pending link. For an **existing connection only**, optionally copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. A complete pair overrides saved credentials. Defining either shell variable selects the whole shell pair without borrowing from `.env`; blank or partial pairs fail. This helper does not read another CLI's credential store.

## Resolve and export

```sh
npm start          # Send the next target question, or read the active Question once.
# Answer in PingRoom, then run again:
npm start
npm run status     # Read saved evidence offline.
npm run report     # Also save private .schema-mapping/report.json.
npm run export     # Save .schema-mapping/mapped.json only when fully valid.
```

Each Question lists the target's type and nullability and all source IDs and labels. Row values stay local. Type an exact source ID, `NoMatch` if none matches, or `Unknown` if unsure. For the sample, answer `live` for `active`, `caption` for `name`, and `qty` for `quantity`; `notes` remains unused.

There are at most four Questions, in target-ID order, each with a 15-minute lifetime. Requests use text input with `max_length: 60` and omit options. PingRoom trims submitted text; code validates the returned normalized string with no additional trimming or case conversion. It verifies answer attribution, null value/label, empty options, request identity and timestamps. It does not retain original untrimmed keystrokes.

Every target needs one known source, no source may serve two targets, and **every row** must satisfy every target's type and nullability. Otherwise `mapped` is null. The report retains separate `noMatchTargetIds`, `unknownTargetIds`, `duplicateSources`, `typeErrors` and unresolved-target diagnostics. Row indexes in type errors are zero-based. Invalid, expired and cancelled answers remain in `readings`; later targets may be collected without replacing failed Questions.

On success, `mapped` contains the input hash, target schema, mapping, rows in their original order and unused source columns. Before completion, `unusedSourceColumns` describes the selections collected so far. `readings` retains Question IDs, the resolver, asking registration, answer and observation times. Local commands replay historical evidence without contacting PingRoom. `export` recomputes and validates that evidence before writing; it refuses partial results and leaves any earlier file unchanged on failure. Consume an artifact only after a successful export for the expected input hash.

Collection exit codes: `0` complete; `1` error; `2` final incomplete/invalid mapping or newly observed invalid/expired/cancelled answer; `3` ready/pending/interrupted; `4` uncertain creation. `status` and `report` exit `0` when readable, so inspect their JSON status and nullable `mapped`. A refused export exits `1`.

## Recover an interrupted request

Creation intent is saved before each POST. A lost response blocks further sends at `create_unknown`:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

The bounded recent-list search returns candidates; no match does not prove creation failed. Inspect the original Question in PingRoom if needed, then recover its exact ID. Recovery validates the request, target, room, resolver, asking registration and timing without resending. Failed reads preserve earlier evidence. Never delete state to bypass uncertainty.

For uncertain or expired **pairing**, inspect Connected Agents and resolve or revoke the old robot before archiving `.pingroom/pairing.json`. For a new mapping session, resolve outstanding Questions and securely archive the entire `.schema-mapping/` directory before changing the input. Preserve old evidence.

## Adapt and verify

`src/model.js` owns deterministic validation and transformation; `src/engine.js` owns durable collection and export. The pure `transform` helper checks data and mapping rules; use a validated report for responder provenance. Implement destination imports separately, with their own authorization and validation. The starter uses no AI and performs no source edits or downstream imports.

The input cap is 128 KiB, config 16 KiB, state/reports 1 MiB and HTTP bodies 512 KiB. IDs begin with a lowercase letter and use lowercase letters, digits, `_` or `-`: mapping ID up to 40 characters, source/target IDs up to 12, excluding prototype-related names. Metadata uses printable ASCII without outer spaces: title 60, field labels 24, resolver label 60. Cell strings allow up to 100 Unicode code points and must be well formed without control or format characters. Integers range from `-9007199254740991` to `9007199254740991`, excluding negative zero.

Private atomic writes use `0600` files and `0700` directories. Inputs, config, credentials and reports are Git-ignored; paths resolve from this project. Requests use only the official API origin, refuse redirects and have a five-second deadline through body consumption. Use one machine with persistent local storage. If a crash leaves `.schema-mapping/.lock` or `.pingroom/.lock`, confirm the recorded process stopped before removing only that stale lock. Restore corrupt state from a valid backup. Saved evidence is not tamper-proof and does not promise distributed exactly-once execution.

Tests include an independent exhaustive mapping oracle, scalar preservation, every-cell type checks, maximum inputs, injection attempts, uncertain creation, interrupted writes, pairing and real CLI subprocesses. GitHub Actions runs tests and the demo on Node 22/24. The [official SDK](https://github.com/pingroom/sdk) is pinned to `0.7.1` with a lockfile and a 14-day npm minimum release age. MIT licensed; see [LICENSE](LICENSE).
