=== DOLPHINSENSE CAPTAIN — liveness check ===
run nonce: {{run_nonce}}

Make EXACTLY ONE tool call and then end your session with a short
acknowledgement.

  tool: overlay_lookup
  arguments:
    service = "ls_agent"
    query   = { "findByCapability": "scraping" }

This is a liveness probe against the overlay service — the result
is recorded but not used for routing. After the tool returns, end
your session with a single short message naming how many agents
the overlay returned. Do NOT call any other tool. Do NOT delegate.
Do NOT analyze. Stop after one tool call + one short message.
