"""EMG backend (Task B) -- BrainFlow (or --mock) WebSocket server on :6970.

Contract (must match frontend/src/contracts.ts EmgMessage exactly):

  Server -> client, pushed at ~40Hz:
    {
      "force": 0.0..1.0,          # normalized clench, primary signal
      "perChannel": [0.0..1.0, ...],  # length 8 (Cyton) or 16 (Cyton+Daisy)
      "mode": "sculpt"|"grab"|"smooth"|"spawn"|"idle",  # optional, LDA classifier (stretch)
      "calibrated": bool,          # false until rest+max calibration has run this session
      "fatigue": 0.0..1.0          # optional, median-freq drop (stretch)
    }

  Client -> server (control messages, JSON):
    {"cmd": "calibrate_rest"} | {"cmd": "calibrate_max"} | {"cmd": "reset"}

Pipeline: BrainFlow (BoardIds.CYTON_DAISY_BOARD, serial port) OR --mock (synthetic force:
slow sine + noise, jumps on stdin, no hardware required) ->
bandpass 20-60 Hz (Butterworth) + 60 Hz notch -> rectify -> 100 ms RMS window
(updated ~40Hz) -> EMA smoothing (alpha ~= 0.2-0.3) -> normalize via per-session
rest/max calibration -> emit EmgMessage.

Never hardcode force thresholds -- amplitude varies by person/placement/session;
always derive 0..1 from the calibrated rest/max range.

Not implemented here -- this is a Task 0 stub. Task B implements the pipeline above,
plus calibration.py (rest/max normalization) and classifier.py (LDA mode, stretch).
"""
