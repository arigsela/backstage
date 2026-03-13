# ==============================================================================
# Orchestrator Prompts & Routing Keywords
# ==============================================================================
{% raw %}
# Keywords that trigger routing to the sub-agent.
# These are matched case-insensitively against the user's query.
ROUTING_KEYWORDS = [
    k.strip().lower()
    for k in "{% endraw %}${{ values.routingKeywords }}{% raw %}".split(",")
    if k.strip()
]
{% endraw %}
