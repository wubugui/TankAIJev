"""Laya 本地适配服务（Python 版）

把 `pip install laya` 的模型包装成与 Jev 相同的 HTTP 接口：
    POST /v1/systemone  {model, state, questions} -> {model, answers, usage}
    GET  /health

用法（需要 Python 3.10+）：
    pip install "laya>=0.3.3"
    python laya_server.py

环境变量：
    LAYA_PORT       端口，默认 8790
    LAYA_REPO       模型仓库，默认 convaiinnovations/laya（英文版）
    LAYA_SUBFOLDER  变体，例如 multilingual / typed-decisions
    LAYA_DEVICE     cuda / cpu（不填由 laya 自己决定）
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("USE_TF", "0")  # laya README：装了 TensorFlow 时可能卡死

import laya  # noqa: E402

HOST = os.environ.get("LAYA_HOST", "127.0.0.1")
PORT = int(os.environ.get("LAYA_PORT", "8790"))
REPO = os.environ.get("LAYA_REPO", "convaiinnovations/laya")
SUBFOLDER = os.environ.get("LAYA_SUBFOLDER") or None
DEVICE = os.environ.get("LAYA_DEVICE") or None
MODEL_NAME = "laya" + (f"-{SUBFOLDER}" if SUBFOLDER else "")

print(f"正在加载 {REPO}{'/' + SUBFOLDER if SUBFOLDER else ''} ……（首次运行会下载权重）", flush=True)
t0 = time.time()
kwargs = {}
if SUBFOLDER:
    kwargs["subfolder"] = SUBFOLDER
if DEVICE:
    kwargs["device"] = DEVICE
agent = laya.load(REPO, **kwargs)
print(f"模型已加载，用时 {time.time() - t0:.1f} 秒", flush=True)

lock = threading.Lock()  # 串行推理


def to_json(obj):
    # numpy 数值等转成普通 float
    return json.dumps(obj, ensure_ascii=False, default=lambda o: float(o) if hasattr(o, "__float__") else str(o))


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        data = to_json(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "model": MODEL_NAME})
        else:
            self._send(404, {"detail": "not found"})

    def do_POST(self):
        if self.path != "/v1/systemone":
            self._send(404, {"detail": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send(400, {"detail": "请求体不是合法 JSON"})
            return
        if "state" not in body or "questions" not in body:
            self._send(422, {"detail": "需要 state 和 questions"})
            return
        start = time.time()
        try:
            with lock:
                result = agent.predict(body["state"], body["questions"])
        except Exception as e:  # 选项太长等错误原样返回，游戏里会显示
            self._send(422, {"detail": str(e)})
            return
        answers = result.get("answers", result) if isinstance(result, dict) else result
        usage = (result.get("usage") if isinstance(result, dict) else None) or {"input_tokens": 0, "output_tokens": 0}
        self._send(200, {
            "model": MODEL_NAME,
            "answers": answers,
            "usage": usage,
            "latency_ms": round((time.time() - start) * 1000),
        })

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"Laya 适配服务已启动：http://{HOST}:{PORT}/v1/systemone （健康检查 /health）", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
