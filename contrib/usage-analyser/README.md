# Usage analyser drop-in

Copy `usage-analyser.ts` and the `usage-analyser/` folder into `~/.pi-pocket/extensions/`.

The analyser uses `aliases.json` for reporting labels. Keys use the recorded provider namespace and model identifier, such as `omni/claude/sonnet`. Values affect report labels only. They do not identify the resolved backend or supply prices. The provider namespace stays separate in reports.

The owner can override or add labels in `<Pi Pocket data directory>/usage-analyser/aliases.json`. This file is read at report time. Explicit values override the shipped catalog labels. Keep keys in `provider/model-id` form. Do not combine providers unless the owner explicitly configures a mapping for each provider.

The default mappings follow the configured Pi model catalog. The extension reads each available display label through `host.modelInfo` for `provider/model-id` keys. It does not copy model costs.

The analyser applies labels to cached and new events during report generation. It does not rewrite cache entries, database records, or historical identifiers. It does not infer resolved backend identity. Unknown costs remain marked `Unknown` in the model table. Labels do not provide model prices.

The tested mappings from the owner configuration are:

- `omni/claude/opus` → `Claude Opus`
- `omni/claude/sonnet` → `Claude Sonnet`

Run the fixtures with:

```sh
node --test contrib/usage-analyser/analyse.test.mjs
```
