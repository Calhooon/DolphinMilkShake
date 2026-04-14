=== SCRAPING WORKER TASK (dolphinsense cycle) ===
run nonce: {{run_nonce}}

You will make EXACTLY ONE or TWO tool calls: execute_bash (to run the
proof batch), then optionally a second execute_bash to read the txid
sidecar file if the first one errored. Then end your session with a
proof report as the final message.

STEP 1 (REQUIRED): call execute_bash with this EXACT command:

  bash {{abs_script_path}} {{worker_wallet_url}} {{abs_records_path}}

The script runs up to 8 concurrent createAction calls and writes each
successful txid as its own line to a sidecar file. It prints a compact
JSON manifest on stdout at the end: proofs_created, errors, txid_file,
first_txid, last_txid, manifest_sha256.

IF STEP 1 ERRORS OR TIMES OUT: the sidecar file still contains every
txid that succeeded before the error. Run ONE more execute_bash call to
count them and build the manifest yourself:

  bash -c 'F={{abs_records_path}}.txids; N=$(wc -l < "$F"); FIRST=$(head -n1 "$F"); LAST=$(tail -n1 "$F"); SHA=$(shasum -a 256 "$F" | cut -d" " -f1); printf "{\"proofs_created\":%d,\"first_txid\":\"%s\",\"last_txid\":\"%s\",\"manifest_sha256\":\"%s\",\"txid_file\":\"%s\"}\n" "$N" "$FIRST" "$LAST" "$SHA" "$F"'

This recovers the REAL numbers. Do not invent values. Do not report zero
unless the sidecar file is empty.

STEP 2 (REQUIRED): end your session by reporting the proof manifest in
plain text on a single final message. Use this EXACT format:

-----BEGIN PROOF REPORT-----
Run {{run_nonce}} proof batch complete.
proofs_created: <N from STEP 1 manifest or recovery manifest>
errors: <M>
first_txid: <first>
last_txid: <last>
manifest_sha256: <sha>
txid_file: <path>
-----END PROOF REPORT-----

Do NOT call any other tool. Do NOT retry execute_bash more than once.
Do NOT reverse-delegate. After printing the report, end your session.
