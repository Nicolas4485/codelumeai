"""Triple-based memory store for Chris.

Stores observations as structured triples (entity, relation, value) with
auto-tagging, observation types, timestamps, and confidence levels.
Supports querying by tags, types, domains, and fuzzy matching.

Backward-compatible: Episode is an alias for Triple, and legacy
(subject, action, result) kwargs still work everywhere.
"""

import json
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path


# Stopwords excluded from auto-tagging
_STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "and", "but", "or", "nor", "not", "so", "yet",
    "it", "its", "i", "my", "me", "we", "our", "you", "your", "he",
    "she", "they", "them", "this", "that", "these", "those", "if", "then",
    "when", "where", "how", "what", "which", "who", "whom",
}


def _auto_tag(entity: str, relation: str, value: str,
              domain: str = "general") -> list[str]:
    """Generate tags from triple content.

    Splits entity/value into words, adds relation, removes stopwords.
    """
    tags = set()
    for text in (entity, value):
        for word in text.lower().split():
            clean = word.strip(".,!?;:'\"()[]")
            if clean and clean not in _STOPWORDS and len(clean) > 1:
                tags.add(clean)
    # Add relation as a tag
    rel_clean = relation.lower().replace("_", " ")
    for word in rel_clean.split():
        if word not in _STOPWORDS and len(word) > 1:
            tags.add(word)
    # Add domain if not "general"
    if domain and domain != "general":
        tags.add(domain.lower())
    return sorted(tags)


@dataclass
class Triple:
    entity: str           # "ball", "cat", "Paris", "2 + 2"
    relation: str         # "when_dropped", "is_a", "capital_of", "equals"
    value: str            # "falls to ground", "animal", "France", "4"
    domain: str = "general"
    tags: list[str] = field(default_factory=list)
    obs_type: str = "causal"  # causal, definitional, property, relational,
                              # mathematical, conditional, procedural
    confidence: float = 1.0
    timestamp: float = field(default_factory=time.time)
    source: str = "teach"     # "teach", "correct", "confirm", "infer"

    # --- Backward-compat aliases (Phase 1 code uses these) ---
    @property
    def subject(self) -> str:
        return self.entity

    @property
    def action(self) -> str:
        return self.relation

    @property
    def result(self) -> str:
        return self.value

    def matches(self, **kwargs) -> bool:
        """Check if this triple matches the given field values.

        Translates legacy names: subject→entity, action→relation, result→value.
        """
        _ALIASES = {"subject": "entity", "action": "relation", "result": "value"}
        for key, val in kwargs.items():
            real_key = _ALIASES.get(key, key)
            if getattr(self, real_key, None) != val:
                return False
        return True

    def to_dict(self) -> dict:
        """Serialize to dict (handles fields that asdict doesn't alias)."""
        return {
            "entity": self.entity,
            "relation": self.relation,
            "value": self.value,
            "domain": self.domain,
            "tags": list(self.tags),
            "obs_type": self.obs_type,
            "confidence": self.confidence,
            "timestamp": self.timestamp,
            "source": self.source,
        }


# Backward-compat alias
Episode = Triple


class Memory:
    """Triple-based memory store. Saves and retrieves observations."""

    def __init__(self, persist_path: str | None = None):
        self.episodes: list[Triple] = []
        self.persist_path = Path(persist_path) if persist_path else None
        if self.persist_path and self.persist_path.exists():
            self._load()

    def add(self, entity=None, relation=None, value=None,
            subject=None, action=None, result=None,
            domain: str = "general", confidence: float = 1.0,
            source: str = "teach", obs_type: str = "causal",
            tags=None) -> Triple:
        """Store a new observation.

        Accepts both new (entity/relation/value) and legacy
        (subject/action/result) kwargs.
        """
        e = entity or subject
        r = relation or action
        v = value or result
        if not e or not r or not v:
            raise ValueError("Must provide entity/relation/value "
                             "(or subject/action/result)")

        if tags is None:
            tags = _auto_tag(e, r, v, domain)

        triple = Triple(
            entity=e, relation=r, value=v,
            domain=domain, tags=tags, obs_type=obs_type,
            confidence=confidence, source=source,
        )
        self.episodes.append(triple)
        self._save()
        return triple

    def query(self, **kwargs) -> list[Triple]:
        """Find triples matching the given fields.

        Supports both legacy (subject=, action=, result=) and
        new (entity=, relation=, value=) field names.
        """
        return [t for t in self.episodes if t.matches(**kwargs)]

    def query_similar(self, action: str,
                      domain: str | None = None) -> list[Triple]:
        """Find triples with the same action/relation (and optionally domain)."""
        filters = {"action": action}
        if domain:
            filters["domain"] = domain
        return self.query(**filters)

    def query_fuzzy(self, subject: str, actions: set[str],
                    threshold: float = 0.75) -> list[Triple]:
        """Find triples matching any of the given actions, with fuzzy
        subject matching.
        """
        from core.parser import fuzzy_match_subject

        known = self.known_entities()
        resolved = fuzzy_match_subject(subject, known, threshold)
        if resolved is None:
            return []

        return [t for t in self.episodes
                if t.entity == resolved and t.relation in actions]

    def query_by_tag(self, tag: str) -> list[Triple]:
        """Find all triples that have the given tag."""
        tag_lower = tag.lower()
        return [t for t in self.episodes if tag_lower in t.tags]

    def query_by_type(self, obs_type: str) -> list[Triple]:
        """Find all triples of a given observation type."""
        return [t for t in self.episodes if t.obs_type == obs_type]

    def known_entities(self) -> set[str]:
        """Return the set of all entities in memory."""
        return {t.entity for t in self.episodes}

    # Backward-compat alias
    def known_subjects(self) -> set[str]:
        return self.known_entities()

    def all_tags(self) -> set[str]:
        """Return all tags across all triples."""
        tags = set()
        for t in self.episodes:
            tags.update(t.tags)
        return tags

    def all_entities(self) -> set[str]:
        """Return all unique entities (both entity and value fields)."""
        entities = set()
        for t in self.episodes:
            entities.add(t.entity)
            entities.add(t.value)
        return entities

    def all(self) -> list[Triple]:
        return list(self.episodes)

    def count(self) -> int:
        return len(self.episodes)

    def _save(self):
        if not self.persist_path:
            return
        self.persist_path.parent.mkdir(parents=True, exist_ok=True)
        data = [t.to_dict() for t in self.episodes]
        self.persist_path.write_text(json.dumps(data, indent=2))

    def _load(self):
        data = json.loads(self.persist_path.read_text())
        self.episodes = []
        for d in data:
            if "entity" in d:
                # New Triple format
                self.episodes.append(Triple(**d))
            else:
                # Legacy Episode format: subject/action/result
                self.episodes.append(Triple(
                    entity=d["subject"],
                    relation=d["action"],
                    value=d["result"],
                    domain=d.get("domain", "general"),
                    tags=_auto_tag(d["subject"], d["action"], d["result"],
                                   d.get("domain", "general")),
                    obs_type="causal",
                    confidence=d.get("confidence", 1.0),
                    timestamp=d.get("timestamp", time.time()),
                    source=d.get("source", "teach"),
                ))
