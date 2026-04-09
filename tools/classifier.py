#!/usr/bin/env python3
"""
DolphinSense Rule-Based Classifier

Reef runs this via execute_bash to classify records without LLM costs.
Handles ~95% of records. Flags ambiguous cases for LLM fallback.

Usage:
    echo '{"record_id": "...", "title": "...", "content": "...", "source": "reddit"}' | python3 classifier.py

    # Batch mode (one JSON record per line):
    cat records.jsonl | python3 classifier.py --batch

Output: JSON with topics, sentiment, entities, relevance_score, confidence, needs_llm
"""

import json
import re
import sys
import hashlib
from collections import defaultdict

# ---------------------------------------------------------------------------
# Topic detection: keyword groups
# ---------------------------------------------------------------------------

TOPIC_KEYWORDS = {
    "ai_agents": [
        "ai agent", "autonomous agent", "agent framework", "multi-agent",
        "tool use", "function calling", "agentic", "agent swarm",
        "langchain", "autogpt", "crewai", "autogen", "ai assistant",
        "llm agent", "agent loop", "agent protocol"
    ],
    "cryptocurrency": [
        "bitcoin", "btc", "ethereum", "eth", "crypto", "blockchain",
        "defi", "web3", "nft", "token", "mining", "hash rate",
        "mempool", "utxo", "satoshi", "wallet", "exchange"
    ],
    "bsv": [
        "bsv", "bitcoin sv", "bitcoinsv", "satoshi vision",
        "overlay", "pushdrop", "op_return", "nanostore",
        "whatsonchain", "1sat", "brc-", "metanet",
        "micropayment", "x402", "brc-100", "brc-52"
    ],
    "machine_learning": [
        "machine learning", "deep learning", "neural network",
        "transformer", "gpt", "llm", "large language model",
        "training", "fine-tuning", "rlhf", "diffusion model",
        "bert", "attention mechanism", "foundation model"
    ],
    "micropayments": [
        "micropayment", "micro-payment", "pay per use", "pay-per-use",
        "nanopayment", "streaming payment", "payment channel",
        "x402", "402 payment", "paywall", "metered access"
    ],
    "regulation": [
        "regulation", "regulatory", "sec", "cftc", "compliance",
        "legislation", "policy", "government", "ban", "restrict",
        "legal", "lawsuit", "enforcement", "sanction"
    ],
    "startups": [
        "startup", "funding", "series a", "series b", "seed round",
        "venture capital", "vc", "valuation", "unicorn", "ipo",
        "acquisition", "pivot", "runway", "burn rate"
    ],
    "open_source": [
        "open source", "open-source", "github", "gitlab", "foss",
        "mit license", "apache license", "contributor", "pull request",
        "repository", "stars", "fork"
    ],
    "security": [
        "vulnerability", "exploit", "hack", "breach", "ransomware",
        "phishing", "zero-day", "cve", "patch", "authentication",
        "encryption", "cybersecurity", "malware"
    ],
    "market_trends": [
        "bull market", "bear market", "price", "rally", "crash",
        "volume", "market cap", "all-time high", "ath", "correction",
        "volatility", "resistance", "support level"
    ],
}

# Compile patterns (case-insensitive, word boundary where possible)
TOPIC_PATTERNS = {}
for topic, keywords in TOPIC_KEYWORDS.items():
    patterns = []
    for kw in keywords:
        # Use word boundaries for short keywords to avoid false matches
        if len(kw) <= 4:
            patterns.append(re.compile(r'\b' + re.escape(kw) + r'\b', re.IGNORECASE))
        else:
            patterns.append(re.compile(re.escape(kw), re.IGNORECASE))
    TOPIC_PATTERNS[topic] = patterns

# ---------------------------------------------------------------------------
# Sentiment lexicon
# ---------------------------------------------------------------------------

POSITIVE_WORDS = {
    "amazing", "awesome", "brilliant", "excellent", "fantastic", "great",
    "impressive", "incredible", "innovative", "love", "outstanding",
    "perfect", "remarkable", "revolutionary", "superb", "wonderful",
    "bullish", "promising", "exciting", "breakthrough", "thriving",
    "soaring", "surging", "growing", "gaining", "winning", "succeed",
    "achievement", "optimistic", "confident", "upgrade", "improve",
    "progress", "advance", "boom", "moon", "rocket", "gem", "undervalued",
    "game-changer", "disruptive", "transformative", "empowering"
}

NEGATIVE_WORDS = {
    "awful", "bad", "broken", "crash", "dead", "disappointing", "disaster",
    "fail", "failure", "fraud", "garbage", "horrible", "scam", "terrible",
    "trash", "worst", "bearish", "dump", "plummet", "collapse", "decline",
    "falling", "losing", "overvalued", "bubble", "ponzi", "rug pull",
    "vulnerability", "exploit", "hack", "breach", "concern", "warning",
    "risk", "threat", "controversy", "backlash", "ban", "restrict",
    "lawsuit", "penalty", "shutdown", "bankrupt", "layoff", "cut"
}

INTENSIFIERS = {"very", "extremely", "incredibly", "absolutely", "totally", "really"}
NEGATORS = {"not", "no", "never", "neither", "nor", "hardly", "barely", "doesn't", "don't", "isn't", "wasn't", "aren't", "won't", "can't", "couldn't", "shouldn't", "wouldn't"}

# ---------------------------------------------------------------------------
# Entity extraction patterns
# ---------------------------------------------------------------------------

TWITTER_HANDLE = re.compile(r'@([A-Za-z0-9_]{1,15})\b')
TICKER = re.compile(r'\$([A-Z]{2,6})\b')
URL_PATTERN = re.compile(r'https?://[^\s<>\"\')\]]+')
PERSON_INDICATORS = re.compile(
    r'\b(?:CEO|CTO|founder|co-founder|professor|Dr\.|said|announced|according to)\s+([A-Z][a-z]+ [A-Z][a-z]+)',
    re.MULTILINE
)
COMPANY_NAMES = {
    "openai", "anthropic", "google", "meta", "microsoft", "apple",
    "nvidia", "tesla", "amazon", "coinbase", "binance", "tether",
    "ripple", "circle", "stripe", "paypal", "square", "block",
    "hugging face", "stability ai", "midjourney", "deepmind",
    "mistral", "cohere", "perplexity", "langchain", "llamaindex"
}

# ---------------------------------------------------------------------------
# Classification functions
# ---------------------------------------------------------------------------

def detect_topics(text):
    """Return list of matching topics sorted by match count."""
    text_lower = text.lower()
    scores = {}
    for topic, patterns in TOPIC_PATTERNS.items():
        count = sum(1 for p in patterns if p.search(text_lower))
        if count > 0:
            scores[topic] = count
    # Sort by match count descending
    sorted_topics = sorted(scores.keys(), key=lambda t: scores[t], reverse=True)
    return sorted_topics[:5]  # Max 5 topics


def score_sentiment(text):
    """Return sentiment score from -1.0 to 1.0 and label."""
    words = re.findall(r'\b\w+\b', text.lower())
    pos_count = 0
    neg_count = 0
    negate = False

    for i, word in enumerate(words):
        if word in NEGATORS:
            negate = True
            continue

        multiplier = 1.5 if (i > 0 and words[i-1] in INTENSIFIERS) else 1.0

        if word in POSITIVE_WORDS:
            if negate:
                neg_count += multiplier
            else:
                pos_count += multiplier
            negate = False
        elif word in NEGATIVE_WORDS:
            if negate:
                pos_count += multiplier
            else:
                neg_count += multiplier
            negate = False
        else:
            # Reset negation after 2 words
            if negate and i > 0:
                negate = False

    total = pos_count + neg_count
    if total == 0:
        return 0.0, "neutral"

    score = (pos_count - neg_count) / total
    # Clamp to [-1, 1]
    score = max(-1.0, min(1.0, score))

    if score > 0.2:
        label = "positive"
    elif score < -0.2:
        label = "negative"
    else:
        label = "neutral"

    return round(score, 3), label


def extract_entities(text):
    """Extract entities: people, companies, tickers, handles, URLs."""
    entities = {
        "people": [],
        "companies": [],
        "projects": [],
        "tickers": [],
        "handles": [],
        "urls": []
    }

    # Twitter handles
    entities["handles"] = list(set(TWITTER_HANDLE.findall(text)))[:10]

    # Tickers
    entities["tickers"] = list(set("$" + t for t in TICKER.findall(text)))[:10]

    # URLs
    entities["urls"] = list(set(URL_PATTERN.findall(text)))[:10]

    # People (names after indicator words)
    people_matches = PERSON_INDICATORS.findall(text)
    entities["people"] = list(set(people_matches))[:10]

    # Companies (case-insensitive matching)
    text_lower = text.lower()
    found_companies = []
    for company in COMPANY_NAMES:
        if company in text_lower:
            # Capitalize properly
            found_companies.append(company.title())
    entities["companies"] = list(set(found_companies))[:10]

    return entities


def compute_relevance(topics, sentiment_score, entities, source):
    """Compute relevance score 0.0-1.0 based on topic matches, entities, and source."""
    score = 0.0

    # Topic relevance (more topics = more relevant)
    score += min(len(topics) * 0.2, 0.6)

    # Entity richness
    entity_count = sum(len(v) for v in entities.values())
    score += min(entity_count * 0.05, 0.2)

    # Strong sentiment is more relevant than neutral
    score += abs(sentiment_score) * 0.1

    # Source bonus (some sources are inherently more relevant)
    source_bonus = {
        "hn": 0.1,      # HN content is usually high quality
        "x_search": 0.1, # Real-time discourse
        "bsv_chain": 0.05,
        "seo_serp": 0.05,
    }
    score += source_bonus.get(source, 0.0)

    return round(min(score, 1.0), 3)


def needs_llm_fallback(topics, sentiment_score, sentiment_label, text):
    """Determine if this record needs LLM classification."""
    # Ambiguous sentiment (close to zero but text is long enough to have opinion)
    if len(text) > 200 and sentiment_label == "neutral":
        # Long text with neutral sentiment might be misclassified
        return True

    # No topics detected but text is substantial
    if len(topics) == 0 and len(text) > 100:
        return True

    # Too many topics (confused classification)
    if len(topics) > 4:
        return True

    # Mixed signals: very positive words AND very negative words in same short text
    words = set(re.findall(r'\b\w+\b', text.lower()))
    pos_hits = len(words & POSITIVE_WORDS)
    neg_hits = len(words & NEGATIVE_WORDS)
    if pos_hits >= 3 and neg_hits >= 3:
        return True

    return False


def classify_record(record):
    """Classify a single record. Returns enriched record dict."""
    text = (record.get("title", "") + " " + record.get("content", "")).strip()
    source = record.get("source", "unknown")
    record_id = record.get("record_id", "unknown")

    if not text:
        return {
            "record_id": record_id,
            "topics": [],
            "sentiment": 0.0,
            "sentiment_label": "neutral",
            "entities": {"people": [], "companies": [], "projects": [], "tickers": [], "handles": [], "urls": []},
            "relevance_score": 0.0,
            "confidence": "low",
            "needs_llm": True,
            "classification_method": "rule_engine",
            "content_hash": hashlib.sha256(text.encode()).hexdigest()
        }

    topics = detect_topics(text)
    sentiment_score, sentiment_label = score_sentiment(text)
    entities = extract_entities(text)
    relevance = compute_relevance(topics, sentiment_score, entities, source)
    needs_llm = needs_llm_fallback(topics, sentiment_score, sentiment_label, text)

    # Confidence based on topic clarity and sentiment strength
    if len(topics) >= 1 and abs(sentiment_score) > 0.2 and not needs_llm:
        confidence = "high"
    elif len(topics) >= 1 or abs(sentiment_score) > 0.1:
        confidence = "medium"
    else:
        confidence = "low"

    return {
        "record_id": record_id,
        "topics": topics,
        "sentiment": sentiment_score,
        "sentiment_label": sentiment_label,
        "entities": entities,
        "relevance_score": relevance,
        "confidence": confidence,
        "needs_llm": needs_llm,
        "classification_method": "rule_engine",
        "content_hash": hashlib.sha256(text.encode()).hexdigest()
    }


def main():
    batch_mode = "--batch" in sys.argv

    if batch_mode:
        # Process one JSON record per line
        results = []
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
                result = classify_record(record)
                results.append(result)
            except json.JSONDecodeError as e:
                results.append({"error": f"Invalid JSON: {e}", "line": line[:100]})
        print(json.dumps(results, indent=2))
    else:
        # Single record mode
        try:
            raw = sys.stdin.read().strip()
            if not raw:
                print(json.dumps({"error": "No input provided"}))
                sys.exit(1)
            record = json.loads(raw)
            result = classify_record(record)
            print(json.dumps(result, indent=2))
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON: {e}"}))
            sys.exit(1)


if __name__ == "__main__":
    main()
