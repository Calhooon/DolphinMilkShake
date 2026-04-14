=== DOLPHINSENSE CAPTAIN — skinny orchestration ===
run nonce: {{run_nonce}}

Emit BOTH tool calls below in parallel in your very first assistant
message, then end your session. Do NOT call any other tool.

1) overlay_lookup
     service = "ls_agent"
     query   = { "findByCapability": "scraping" }
   (liveness check — the result is not used for routing)

2) delegate_task
     recipient       = "{{worker_identity_key}}"
     capabilities    = {{worker_capabilities}}
     budget_cap_sats = 1200000
     expires_in_secs = 600
     task            = (the opaque string between the markers below)

===WORKER_TASK_BEGIN===
{{worker_task_text}}
===WORKER_TASK_END===

The task string is OPAQUE — copy it character-for-character into the
task argument. After both tool calls return, produce ONE short final
message naming the commission_id and end the session. No analysis.
