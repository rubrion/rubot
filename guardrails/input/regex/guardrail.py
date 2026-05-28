import re
import unicodedata
from pathlib import Path

BANNED_WORDS_PATH = Path(__file__).resolve().parent / "banned_words.txt"


class RegexGuardrail:
    def __init__(self, banned_words_path: str | Path = BANNED_WORDS_PATH):
        words = Path(banned_words_path).read_text(encoding="utf-8").splitlines()
        words = [w.strip() for w in words if w.strip()]
        pattern = "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))
        self.regex = re.compile(rf"\b({pattern})\b", re.IGNORECASE)

    @staticmethod
    def _normalize(text: str) -> str:
        text = unicodedata.normalize("NFKD", text)
        text = "".join(c for c in text if not unicodedata.combining(c))
        return text.lower()

    def evaluate(self, text: str) -> dict:
        normalized = self._normalize(text)
        matches = self.regex.findall(normalized)
        if matches:
            return {"verdict": "blocked", "matched": list(set(matches))}
        return {"verdict": "allowed", "matched": []}
