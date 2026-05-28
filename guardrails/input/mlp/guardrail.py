import os

import joblib
import numpy as np
import openai

MODEL_PATH = os.environ.get(
    "MLP_MODEL_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "model", "input_guardrail_mlp.joblib"),
)

THRESHOLD_BLOCK = 0.60
THRESHOLD_RELEASE = 0.60


class InputGuardrail:
    def __init__(
        self,
        threshold_block: float = THRESHOLD_BLOCK,
        threshold_release: float = THRESHOLD_RELEASE,
        openai_key: str = None,
    ):
        artifact = joblib.load(MODEL_PATH)
        self.model = artifact["model"]
        self.label_encoder = artifact["label_encoder"]
        self.embedding_model = artifact["embedding_model"]
        self.threshold_block = threshold_block
        self.threshold_release = threshold_release

        self.openai_key = openai_key or os.environ.get("OPENAI_API_KEY")
        if not self.openai_key:
            raise ValueError("Provide OPENAI_API_KEY via env var or openai_key param")

        self.client = openai.OpenAI(api_key=self.openai_key)

    def _get_embedding(self, text: str) -> np.ndarray:
        response = self.client.embeddings.create(input=[text], model=self.embedding_model)
        return np.array([response.data[0].embedding])

    def evaluate(self, prompt: str) -> dict:
        emb = self._get_embedding(prompt)
        proba = self.model.predict_proba(emb)[0]

        classes = list(self.label_encoder.classes_)
        prob_dict = {cls: round(float(p), 4) for cls, p in zip(classes, proba)}

        prob_illegit = prob_dict.get("illegitimate", 0)
        prob_legit = prob_dict.get("legitimate", 0)

        if prob_illegit >= self.threshold_block:
            verdict = "blocked"
        elif prob_legit >= self.threshold_release:
            verdict = "allowed"
        else:
            verdict = "review"

        return {
            "verdict": verdict,
            "probabilities": prob_dict,
            "thresholds": {
                "block": self.threshold_block,
                "release": self.threshold_release,
            },
        }
