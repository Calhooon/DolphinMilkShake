#!/usr/bin/env bash
#
# provision-fleet-wallets.sh -- create the fleet wallet inventory.
#
# Reads fleet/lanes.json, generates ROOT_KEYs, writes env files to
# ~/bsv/wallets/fleet/, and runs `bsv-wallet init` for each wallet.
#
# Paranoid ordering (so we never lose a ROOT_KEY):
#   1. Generate the key in memory (openssl rand -hex 32)
#   2. WRITE the .env file to disk with ROOT_KEY + all metadata — durable backup
#   3. fsync the .env file (cat it back to verify)
#   4. THEN run `bsv-wallet init --key <key> --db <path>` to create the DB
#   5. Verify round-trip via `identity` with sourced env
#   6. Append to INVENTORY.json
#   7. Update secrets.md-style safety backup at ~/bsv/wallets/fleet/INVENTORY.md
#
# If ANY step fails after step 2, the ROOT_KEY is on disk in the .env
# file so the wallet can be recovered manually.
#
# Idempotent: skips wallets whose env file already exists.
#
# Usage:
#   ./scripts/provision-fleet-wallets.sh [--dry-run] [--lanes <path>] [--wallet-dir <path>]
#
# Defaults:
#   --lanes       fleet/lanes.json (relative to repo root)
#   --wallet-dir  ~/bsv/wallets/fleet/
#
# Exit codes:
#   0  all wallets provisioned (or already existed)
#   1  usage error
#   2  missing dependency (openssl, jq, bsv-wallet)
#   3  missing lanes.json
#   4  init failed for one or more wallets
#   5  env-write verification failed (should never happen — panic)

set -euo pipefail

# ---- defaults ---------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANES_FILE="$REPO_ROOT/fleet/lanes.json"
WALLET_DIR="$HOME/bsv/wallets/fleet"
BIN="${BIN:-$HOME/bsv/bsv-wallet-cli/target/release/bsv-wallet}"
DRY_RUN=0

# ---- arg parse --------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)      DRY_RUN=1; shift ;;
        --lanes)        LANES_FILE="$2"; shift 2 ;;
        --wallet-dir)   WALLET_DIR="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,30p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 1 ;;
    esac
done

# ---- color helpers ----------------------------------------------------
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'
log()   { printf '%s[provision]%s %s\n' "$BLUE" "$NC" "$*" >&2; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$NC" "$*" >&2; }
warn()  { printf '  %s⚠%s %s\n' "$YELLOW" "$NC" "$*" >&2; }
bad()   { printf '  %s✗%s %s\n' "$RED" "$NC" "$*" >&2; }
panic() { printf '%s[PANIC]%s %s\n' "$RED" "$NC" "$*" >&2; }

# ---- dependency checks ------------------------------------------------
command -v openssl >/dev/null 2>&1 || { bad "openssl required"; exit 2; }
command -v jq >/dev/null 2>&1      || { bad "jq required"; exit 2; }
[ -x "$BIN" ] || { bad "bsv-wallet binary not found: $BIN"; exit 2; }
[ -f "$LANES_FILE" ] || { bad "lanes.json not found: $LANES_FILE"; exit 3; }

log "repo root:   $REPO_ROOT"
log "lanes file:  $LANES_FILE"
log "wallet dir:  $WALLET_DIR"
log "bsv-wallet:  $BIN"
log "dry run:     $DRY_RUN"

mkdir -p "$WALLET_DIR"

INVENTORY_JSON="$WALLET_DIR/INVENTORY.json"
INVENTORY_MD="$WALLET_DIR/INVENTORY.md"

# Initialize inventory.json if missing
if [ ! -f "$INVENTORY_JSON" ]; then
    if [ "$DRY_RUN" -eq 0 ]; then
        printf '{"wallets":[]}\n' > "$INVENTORY_JSON"
    fi
fi

# ---- walk lanes.json, emit one TSV row per wallet ---------------------
# Format: lane_id\tsubreddit\trole\twallet_name\tserver_port\twallet_port
wallet_tsv=$(
    jq -r '.lanes[] | .id as $lid | .subreddit as $sub |
        (.agents[] | [$lid, $sub, .role, .name, .server_port, .wallet_port] | @tsv)' \
        "$LANES_FILE"
)
TOTAL=$(printf '%s\n' "$wallet_tsv" | grep -c . || true)
log "planning $TOTAL wallet provisions"

CREATED=0
SKIPPED=0
FAILED=0

# ---- helper: write env file atomically --------------------------------
# Writes to .env.tmp, fsyncs via cat back, then renames. If rename fails
# we keep the .tmp file so nothing is lost.
write_env_file() {
    local env_path="$1"
    local root_key="$2"
    local name="$3"
    local role="$4"
    local lane_id="$5"
    local subreddit="$6"
    local server_port="$7"
    local wallet_port="$8"
    local db_path="$9"

    local tmp="${env_path}.tmp"
    cat > "$tmp" <<EOF
# DolphinSense fleet wallet env file
# Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
# DANGER: contains ROOT_KEY — private key for spending.
#         Never commit. Never rm. Never rekey.
ROOT_KEY=$root_key
WALLET_NAME=$name
WALLET_ROLE=$role
LANE_ID=$lane_id
LANE_SUBREDDIT=$subreddit
SERVER_PORT=$server_port
WALLET_PORT=$wallet_port
DB_PATH=$db_path
EOF
    # Verify the file was written by cat-ing it back and grepping for ROOT_KEY
    local readback
    readback=$(grep '^ROOT_KEY=' "$tmp" 2>/dev/null || true)
    if [ "$readback" != "ROOT_KEY=$root_key" ]; then
        panic "env file write verification FAILED for $env_path"
        panic "tmp file left on disk at: $tmp"
        return 1
    fi
    mv "$tmp" "$env_path"
    return 0
}

# ---- provision each wallet --------------------------------------------
while IFS=$'\t' read -r lane_id subreddit role name server_port wallet_port; do
    [ -z "$name" ] && continue

    env_path="$WALLET_DIR/${name}.env"
    db_path="$WALLET_DIR/${name}.db"

    printf '\n[%s] (%s, lane=%s, sub=r/%s, server=%d, wallet=%d)\n' \
        "$name" "$role" "$lane_id" "$subreddit" "$server_port" "$wallet_port" >&2

    # Idempotent: skip if env already exists AND has a ROOT_KEY line
    if [ -f "$env_path" ] && grep -q '^ROOT_KEY=[a-f0-9]\{64\}$' "$env_path"; then
        ok "already provisioned (env exists)"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
        ok "[DRY RUN] would create env + db"
        continue
    fi

    # 1. Generate fresh ROOT_KEY
    root_key=$(openssl rand -hex 32)
    log "generated root key (not echoed)"

    # 2. Write env file FIRST (durable backup before init)
    if ! write_env_file "$env_path" "$root_key" "$name" "$role" "$lane_id" "$subreddit" "$server_port" "$wallet_port" "$db_path"; then
        FAILED=$((FAILED + 1))
        exit 5
    fi
    ok "env written: $env_path"

    # 3. Init the wallet DB (may also write its own .env next to the db;
    #    our env_path is the canonical one so we'll overwrite if it does)
    init_out=$("$BIN" --db "$db_path" init --key "$root_key" --json 2>&1 || true)
    if ! printf '%s' "$init_out" | grep -q 'Wallet initialized\|identityKey'; then
        bad "init failed: $init_out"
        FAILED=$((FAILED + 1))
        # Env file is still on disk — not lost
        continue
    fi
    # init may OVERWRITE our richer env file with just ROOT_KEY — rewrite ours
    if ! write_env_file "$env_path" "$root_key" "$name" "$role" "$lane_id" "$subreddit" "$server_port" "$wallet_port" "$db_path"; then
        FAILED=$((FAILED + 1))
        exit 5
    fi

    # 4. Verify via identity command
    identity_json=$( ( set +u; export $(grep -v '^\s*#' "$env_path" | xargs); \
                      "$BIN" --db "$db_path" identity --json 2>/dev/null ) || true )
    identity_key=$(printf '%s' "$identity_json" | jq -r '.identityKey // empty' 2>/dev/null)
    address=$(printf '%s' "$identity_json" | jq -r '.address // empty' 2>/dev/null)
    if [ -z "$identity_key" ] || [ "${#identity_key}" -ne 66 ]; then
        bad "identity verification failed for $name"
        FAILED=$((FAILED + 1))
        continue
    fi
    ok "identity: ${identity_key:0:16}... (addr $address)"

    # 5. Append to INVENTORY.json
    tmp_inv="${INVENTORY_JSON}.tmp"
    jq --arg name "$name" \
       --arg role "$role" \
       --arg lane "$lane_id" \
       --arg sub "$subreddit" \
       --argjson sport "$server_port" \
       --argjson wport "$wallet_port" \
       --arg ikey "$identity_key" \
       --arg addr "$address" \
       --arg env "$env_path" \
       --arg db "$db_path" \
       --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       '.wallets += [{
            name: $name, role: $role, lane_id: $lane, subreddit: $sub,
            server_port: $sport, wallet_port: $wport,
            identity_key: $ikey, address: $addr,
            env_path: $env, db_path: $db, created_at: $ts
        }]' "$INVENTORY_JSON" > "$tmp_inv" \
    && mv "$tmp_inv" "$INVENTORY_JSON"

    CREATED=$((CREATED + 1))
done <<< "$wallet_tsv"

# ---- write human-readable INVENTORY.md --------------------------------
if [ "$DRY_RUN" -eq 0 ] && [ -s "$INVENTORY_JSON" ]; then
    {
        printf '# Fleet wallet inventory\n\n'
        printf '> Generated by `scripts/provision-fleet-wallets.sh`. Do NOT hand-edit — regenerate from .env files if you need to rebuild.\n\n'
        printf '> **DANGER**: the actual `ROOT_KEY` values live in the .env files in this directory. They are NOT committed to git. Losing an .env file = losing the funds.\n\n'
        printf '| name | role | lane | sub | server | wallet | identity (pub prefix) | address |\n'
        printf '|---|---|---|---|---:|---:|---|---|\n'
        jq -r '.wallets[] | [.name, .role, .lane_id, ("r/" + .subreddit),
                             (.server_port|tostring), (.wallet_port|tostring),
                             (.identity_key[0:16] + "..."), .address] | @tsv' \
            "$INVENTORY_JSON" | \
            awk -F'\t' '{printf "| %s | %s | %s | %s | %s | %s | `%s` | `%s` |\n", $1, $2, $3, $4, $5, $6, $7, $8}'
        printf '\n'
        printf '## Recovery\n\n'
        printf 'If a daemon dies without its env file dumped, the funds are on-chain but unspendable until ROOT_KEY is recovered. The .env files here ARE the ROOT_KEY backup. Never delete them while funds are held.\n'
    } > "$INVENTORY_MD"
    ok "wrote $INVENTORY_MD"
fi

# ---- summary ----------------------------------------------------------
printf '\n' >&2
log "summary: $CREATED created, $SKIPPED skipped (already existed), $FAILED failed (total $TOTAL)"
if [ "$FAILED" -gt 0 ]; then
    bad "some wallets failed to provision — check env files on disk for any partial state"
    exit 4
fi
log "done"
exit 0
