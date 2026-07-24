"""Vision backend (Task A) -- eventlet WebSocket server on :6969, path /ws.

Mirrors ShapeShift's known-working pattern: eventlet (monkey-patched) + flask +
eventlet.websocket.WebSocketWSGI, combined into one WSGI app that dispatches
`/ws` to the raw WebSocket handler and everything else to Flask.

Contract (must match frontend/src/contracts.ts VisionMessage/VisionHand exactly):

  Client -> server: one raw JPEG frame per message, as bytes (ArrayBuffer on the
  client side), mirrored, resized to 640x360, quality ~0.5.

  Server -> client, per frame received:
    {
      "status": "success" | "dropped",
      "hands": [
        {
          "handedness": "Left" | "Right",
          "landmarks": [[x_px, y_px, z_rel], ...] (21 entries, x in 0..640, y in 0..360),
          "connections": [[a, b], ...]
        },
        ...
      ],
      "image_size": {"width": 640, "height": 360}
    }
    "dropped" (hands/image_size omitted) whenever the 50ms wall-clock frame budget is
    exceeded at any checkpoint (decode/resize/inference/per-hand loop).

Pipeline (verbatim params, mirrors ShapeShift -- do not change):
  cv2.imdecode -> resize to 640x360 -> BGR->RGB ->
  mp.solutions.hands.Hands(static_image_mode=False, max_num_hands=2,
                           min_detection_confidence=0.65, min_tracking_confidence=0.65)
  -> dedup to first Left + first Right hand -> emit VisionMessage as orjson.

Deliberately dropped vs ShapeShift: the symbol/template-matching classifier
(detected_symbols) -- EMG + camera-pose modes cover our interaction needs instead.
"""

import time

import eventlet

eventlet.monkey_patch()

import cv2
import mediapipe as mp
import numpy as np
import orjson
from eventlet import wsgi
from eventlet.websocket import WebSocketWSGI
from flask import Flask

FRAME_BUDGET_MS = 50
FRAME_WIDTH = 640
FRAME_HEIGHT = 360

app = Flask(__name__)

mp_hands = mp.solutions.hands
hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=2,
    min_detection_confidence=0.65,
    min_tracking_confidence=0.65,
)
HAND_CONNECTIONS = [[a, b] for a, b in mp_hands.HAND_CONNECTIONS]


@app.route("/")
def index():
    """Liveness placeholder; the real client talks to /ws."""
    return "forceclay vision backend"


def _dropped():
    return orjson.dumps({"status": "dropped"})


def _over_budget(start_time: float) -> bool:
    return (time.monotonic() - start_time) * 1000 > FRAME_BUDGET_MS


@WebSocketWSGI
def handle_websocket(ws):
    """Per-connection loop: one JPEG frame in, one VisionMessage out."""
    while True:
        message = ws.wait()
        if message is None:
            break
        try:
            start_time = time.monotonic()

            np_arr = np.frombuffer(message, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            if frame is None:
                ws.send(_dropped())
                continue

            frame = cv2.resize(frame, (FRAME_WIDTH, FRAME_HEIGHT))
            h, w = frame.shape[:2]

            if _over_budget(start_time):
                ws.send(_dropped())
                continue

            results = hands.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

            if _over_budget(start_time):
                ws.send(_dropped())
                continue

            hands_data = []
            seen = {"Left": False, "Right": False}

            if results.multi_hand_landmarks:
                for idx, landmarks in enumerate(results.multi_hand_landmarks):
                    if _over_budget(start_time):
                        ws.send(_dropped())
                        hands_data = None
                        break

                    handedness = results.multi_handedness[idx].classification[0].label
                    if seen[handedness]:
                        continue
                    seen[handedness] = True

                    hand_landmarks = [
                        [round(lm.x * w, 3), round(lm.y * h, 3), round(lm.z, 3)]
                        for lm in landmarks.landmark
                    ]
                    hands_data.append(
                        {
                            "handedness": handedness,
                            "landmarks": hand_landmarks,
                            "connections": HAND_CONNECTIONS,
                        }
                    )

                if hands_data is None:
                    continue

            if _over_budget(start_time):
                ws.send(_dropped())
                continue

            ws.send(
                orjson.dumps(
                    {
                        "status": "success",
                        "hands": hands_data,
                        "image_size": {"width": w, "height": h},
                    }
                )
            )
        except Exception as e:  # keep the connection alive across frame errors
            print("WebSocket error:", str(e))


def combined_app(environ, start_response):
    """Dispatch /ws to the raw WebSocket handler, everything else to Flask."""
    if environ["PATH_INFO"] == "/ws":
        return handle_websocket(environ, start_response)
    return app(environ, start_response)


if __name__ == "__main__":
    wsgi.server(eventlet.listen(("0.0.0.0", 6969), reuse_port=True), combined_app)
