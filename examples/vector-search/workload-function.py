def run(payload):
    """Rank bounded quantized vectors by inner product on the assigned GPU."""
    import os
    import re
    import torch

    def vector(v):
        return (isinstance(v, list) and 1 <= len(v) <= 64
                and all(type(x) is int and -100 <= x <= 100 for x in v))

    if set(payload) != {"query", "items", "topK"} or not vector(payload["query"]):
        raise ValueError("invalid query")
    query, items, k = payload["query"], payload["items"], payload["topK"]
    if not isinstance(items, list) or not 1 <= len(items) <= 64 or type(k) is not int or not 1 <= k <= min(10, len(items)):
        raise ValueError("invalid items/topK")
    ids = set()
    for item in items:
        if (not isinstance(item, dict) or set(item) != {"id", "vector"}
                or not isinstance(item["id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", item["id"])
                or item["id"] in ids or not vector(item["vector"]) or len(item["vector"]) != len(query)):
            raise ValueError("invalid item")
        ids.add(item["id"])
    if (not re.fullmatch(r"GPU-[A-Fa-f0-9-]{32,64}", os.environ.get("CUDA_VISIBLE_DEVICES", ""))
            or not torch.cuda.is_available() or torch.cuda.device_count() != 1):
        raise RuntimeError("assigned CUDA device unavailable")
    with torch.inference_mode():
        # float64 exactly represents every permitted integer product and sum.
        matrix = torch.tensor([item["vector"] for item in items], dtype=torch.float64, device="cuda:0")
        q = torch.tensor(query, dtype=torch.float64, device="cuda:0")
        scores = torch.mv(matrix, q).tolist()
        torch.cuda.synchronize()
    ranked = sorted(({"id": item["id"], "score": int(score)} for item, score in zip(items, scores)),
                    key=lambda item: (-item["score"], item["id"]))
    return {"backend": "pytorch-cuda", "metric": "inner-product", "ranked": ranked[:k]}
