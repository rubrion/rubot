import asyncio
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"

SCORE_PATTERN = re.compile(r">>\s*SCORE:\s*(\d)")

THRESHOLD_BLOCK = 4
THRESHOLD_REVIEW = 3


@dataclass
class _ModelCfg:
    provider: str = "openai"
    model: str = "gpt-4.1-mini"
    temperature: float = 0.1
    max_tokens: int = 256

    def chat_kwargs(self, **overrides: Any) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        if self.temperature is not None and "temperature" not in overrides:
            kwargs["temperature"] = self.temperature
        if self.max_tokens is not None and "max_tokens" not in overrides:
            kwargs["max_tokens"] = self.max_tokens
        for k, v in overrides.items():
            if v is not None:
                kwargs[k] = v
        return kwargs


class OutputGuardrail:
    def __init__(
        self,
        pillars: list[str] | None = None,
        threshold_block: int = THRESHOLD_BLOCK,
        threshold_review: int = THRESHOLD_REVIEW,
        model: str | None = None,
        temperature: float | None = None,
        provider: str = "openai",
        openai_key: str | None = None,
    ):
        self.threshold_block = threshold_block
        self.threshold_review = threshold_review

        self.cfg = _ModelCfg(
            provider=provider,
            model=model or "gpt-4.1-mini",
            temperature=temperature if temperature is not None else 0.1,
        )

        api_key = openai_key or os.environ.get(
            "ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENAI_API_KEY", ""
        )

        if self.cfg.provider == "anthropic":
            from anthropic import AsyncAnthropic
            self._client: Any = AsyncAnthropic(api_key=api_key)
        else:
            from openai import AsyncOpenAI
            self._client = AsyncOpenAI(api_key=api_key)

        available = {p.stem: p for p in PROMPTS_DIR.glob("*.txt")}
        names = pillars or list(available.keys())
        self.prompts: dict[str, str] = {}
        for name in names:
            path = available.get(name)
            if path is None:
                raise ValueError(f"Pillar '{name}' not found in {PROMPTS_DIR}")
            self.prompts[name] = path.read_text(encoding="utf-8").strip()

    def _build_user_message(self, question: str, answer: str) -> str:
        return f"Question: {question}\nAnswer: {answer}"

    def _parse_score(self, text: str) -> int | None:
        match = SCORE_PATTERN.search(text)
        if match:
            return int(match.group(1))
        return None

    async def evaluate_pillar(self, pillar: str, question: str, answer: str) -> dict:
        system = self.prompts[pillar]
        user_msg = self._build_user_message(question, answer)

        if self.cfg.provider == "anthropic":
            return await self._evaluate_anthropic(pillar, system, user_msg)
        return await self._evaluate_openai(pillar, system, user_msg)

    async def _evaluate_openai(self, pillar: str, system: str, user_msg: str) -> dict:
        response = await self._client.chat.completions.create(
            model=self.cfg.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            **self.cfg.chat_kwargs(),
        )
        raw = response.choices[0].message.content or ""
        usage = response.usage
        return {
            "pillar": pillar,
            "score": self._parse_score(raw),
            "raw": raw.strip(),
            "tokens": {
                "input": usage.prompt_tokens if usage else 0,
                "output": usage.completion_tokens if usage else 0,
                "total": usage.total_tokens if usage else 0,
            },
        }

    async def _evaluate_anthropic(self, pillar: str, system: str, user_msg: str) -> dict:
        response = await self._client.messages.create(
            model=self.cfg.model,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
            max_tokens=self.cfg.max_tokens or 256,
            **self.cfg.chat_kwargs(max_tokens=None),
        )
        raw = "".join(b.text for b in response.content if b.type == "text")
        usage = response.usage
        return {
            "pillar": pillar,
            "score": self._parse_score(raw),
            "raw": raw.strip(),
            "tokens": {
                "input": usage.input_tokens if usage else 0,
                "output": usage.output_tokens if usage else 0,
                "total": (usage.input_tokens or 0) + (usage.output_tokens or 0) if usage else 0,
            },
        }

    async def evaluate(self, question: str, answer: str) -> dict:
        tasks = [
            self.evaluate_pillar(pillar, question, answer)
            for pillar in self.prompts
        ]
        results = await asyncio.gather(*tasks)

        scores = [r["score"] for r in results if r["score"] is not None]
        max_score = max(scores) if scores else 0

        if max_score >= self.threshold_block:
            verdict = "blocked"
        elif max_score >= self.threshold_review:
            verdict = "review"
        else:
            verdict = "allowed"

        total_tokens = {
            "input": sum(r["tokens"]["input"] for r in results),
            "output": sum(r["tokens"]["output"] for r in results),
            "total": sum(r["tokens"]["total"] for r in results),
        }

        return {
            "verdict": verdict,
            "max_score": max_score,
            "pillars": list(results),
            "tokens": total_tokens,
        }
