"""Vision backend (Task A) -- eventlet WebSocket server on :6969, path /ws.

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
    exceeded at any checkpoint (decode/resize/inference/encode).

Pipeline (verbatim params, mirrors ShapeShift -- do not change):
  cv2.imdecode -> resize to 640x360 -> BGR->RGB ->
  mp.solutions.hands.Hands(static_image_mode=False, max_num_hands=2,
                           min_detection_confidence=0.65, min_tracking_confidence=0.65)
  -> dedup to first Left + first Right hand -> emit VisionMessage as orjson.

Stack: eventlet (monkey-patched) + flask (a couple of HTTP routes) +
eventlet.websocket.WebSocketWSGI, listening on 0.0.0.0:6969.

Not implemented here -- this is a Task 0 stub. Task A implements the pipeline above.
"""
