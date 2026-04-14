=== SYNTHESIS AGENT TASK (dolphinsense valuable read) ===
run nonce: {{run_nonce}}

The scraping worker just hashed and proof-batched {{proofs_created}} records
from r/{{subreddit}} and pinned an OP_RETURN tx for each one. Your job is
to read the annotated records (one line per record, each line carries
both the original record AND its on-chain txid), upload the txid list
to NanoStore, write a cited HTML analysis article, and upload it too.

You will make EXACTLY THREE tool calls:
  1. file_read           — read the annotated records file
  2. upload_to_nanostore — upload a plaintext txid manifest
  3. upload_to_nanostore — upload the finished HTML article

STEP 1 (REQUIRED): file_read

  path: {{abs_annotated_path}}

This file has ONE JSON object per line, shape:

  {"txid":"<64-char hex>","record":{...original record fields...}}

Each line is a real Reddit post or comment whose content hash is pinned
to BSV via the `txid` field. Read all of it. The `record` sub-object
has fields like body, author, score, id, title, permalink.
Expected proofs: {{proofs_created}}. Manifest sha256: {{manifest_sha_prefix}}…

STEP 2 (REQUIRED): upload_to_nanostore — txid manifest from FILE

The harness has already written the complete, authoritative txid
manifest (one txid per line, exact line order matching the annotated
file) to disk. DO NOT try to compose this manifest yourself — you will
truncate it. Upload the file AS IS via the file_path parameter:

  tool: upload_to_nanostore
  arguments:
    file_path:         "{{abs_txids_path}}"
    retention_minutes: 525600
    content_type:      "text/plain"

Do NOT provide a `content` argument. Do NOT read the file into your
context first — let the tool stream the bytes directly from disk.
Remember the returned public URL. Reference it in STEP 3 as TXIDS_URL.

STEP 3 (REQUIRED): upload_to_nanostore — HTML article

Compose a complete standalone HTML5 document containing a 1000-1500
word analysis article. The HTML must include:

  - <!DOCTYPE html>, <html lang="en">, <head>, <body>
  - <meta charset="utf-8"> + <meta name="viewport" content="width=device-width, initial-scale=1">
  - <title> with the article headline
  - <style> block with:
      * system font stack (-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif)
      * max-width ~720px centered, line-height 1.6-1.7
      * dark text on light background, hierarchical headings
      * <blockquote> left-border accent + subtle background
      * <code> monospace + subtle background (for txid citations)
      * footer card with subtle background for Provenance Note
      * mobile responsive via viewport meta + @media (max-width:420px)
  - Article body inside <main class="container"> or <article>
  - Sections as <section> blocks with <h2> headings:
      Key Themes, Notable Discussions, Sentiment & Context, Analysis,
      Provenance Note

=== CRITICAL: inline citations with on-chain txids ===

Every direct quote MUST carry its on-chain txid inline. Use this
EXACT blockquote pattern, with the txid taken from the SAME line in
the annotated file as the record you are quoting:

  <blockquote>
    "Quoted text from the record body..."
    <footer>— @&lt;author&gt; · <code>&lt;full 64-char txid&gt;</code></footer>
  </blockquote>

Include AT LEAST 4 different <blockquote> citations in the article,
each with a DIFFERENT txid. The txid must match the record you quote
— a judge should be able to paste any cited txid into
whatsonchain.com/tx/ and find the exact OP_RETURN that hashes to
the quoted content.

=== Provenance Note section (REQUIRED content) ===

The final <section> (Provenance Note) must include:

  <p><strong>On-chain proofs:</strong> {{proofs_created}} records were
     hashed and pinned to BSV via OP_RETURN transactions.</p>
  <p><strong>Manifest sha256:</strong> <code>{{manifest_sha}}</code></p>
  <p><strong>Run nonce:</strong> <code>{{run_nonce}}</code></p>
  <p><strong>Full txid manifest:</strong>
     <a href="TXIDS_URL">TXIDS_URL</a> — one txid per line, in the
     same order as the scraped records. Each line maps 1:1 to a
     quoted record in this article.</p>
  <p>To verify any claim: copy a <code>&lt;code&gt;</code>-wrapped
     txid above, look it up on a BSV block explorer, and inspect the
     OP_RETURN output. Its 32-byte payload is the SHA-256 of the
     canonical jq-compact JSON of the quoted record.</p>

Replace TXIDS_URL above with the actual URL returned by STEP 2.

=== Upload the HTML ===

Call upload_to_nanostore with:

  content:           <full HTML document as a single string>
  retention_minutes: 525600
  content_type:      "text/html"

=== Report ===

End your session with BOTH URLs on separate lines in this EXACT
format (no other output needed before or after):

  TXIDS_URL: <url from STEP 2>
  NANOSTORE_URL: <url from STEP 3>

Do NOT call any other tool. Do NOT call file_write. Do NOT call
search_tools. Compose the HTML and the txid manifest directly as
strings in the tool_call arguments.

IMPORTANT: this article is the PRODUCTION DELIVERABLE judges will
open in a browser. Every quoted <blockquote> must carry a real
on-chain txid. Typography, spacing, structure, and correct txid
citations all matter.
