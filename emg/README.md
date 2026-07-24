# EMG backend

Turns a forearm clench into `force: 0..1` on `ws://localhost:6970`, matching
`frontend/src/contracts.ts` `EmgMessage`. Camera says WHERE, this says HOW HARD.

```
emg/
  emg_server.py      WS server (:6970). --mock needs no hardware.
  calibration.py     per-session rest/max normalisation
  obci/              board bridge + DSP (shared with the tools below)
  tools/
    live_server.py   localhost oscilloscope + labelled-session recorder
    live_monitor.py  CLI signal-quality monitor
    fit_weights.py   fit the force-axis channel weights from a recording
    selftest.py      hardware-free pipeline check
    train_gesture.py gesture classifier (LORO eval)
```

## Run

```bash
pip install -r requirements.txt
python emg_server.py --mock                                  # no hardware
python emg_server.py --serial-port /dev/cu.usbserial-XXXX    # real board
```

Defaults to `--board cyton` (8 channels @ 250 Hz) combining channels 1, 2 and 4.
Override with `--channels 1,2,4 --weights 0.515,0.345,-0.140`.

## Hardware

**Cyton, not Cyton+Daisy.** Daisy interleaves two ADS1299 chips, so 16 channels
arrive at 125 Hz each instead of 250. The ADS1299's sinc³ decimation filter is
−3 dB at `0.262 × f_DATA` — 33 Hz at 125 Hz vs 66 Hz at 250 Hz — and sEMG median
frequency is 50–100 Hz, so Daisy attenuates the middle of our own signal. Force is
one envelope, so extra channels buy nothing the bandwidth costs. A Daisy may be
physically attached and idle; `CYTON_BOARD` still streams 8 channels at a measured
247.9 Hz. `--board cyton_daisy` restores 16 × 125 Hz if you ever want it.

**Bipolar pairs, one channel per muscle.** Each channel takes *both* pins of its
`NxP` column (top = P, bottom = N). `SRB1`/`SRB2` stay empty; `BIAS` goes to a bony
landmark (olecranon). The Cyton boots with SRB2 ON, referencing every channel to a
shared rail that is unwired in a bipolar montage — every connected channel then
reads ~100% mains hum. `obci.bridge.configure_channels()` sends the per-channel
`x..` commands that switch to true INxP-vs-INxN and power down unused channels so
their electrodes stay out of the BIAS loop. Do not skip it.

Placement the default weights assume, all in the proximal third of the forearm over
the muscle bellies, each pair oriented *along* the limb axis (these fibres are
longitudinal; a cross-fibre pair loses most of its signal):

| channel | muscle | aspect | palpation check |
|---|---|---|---|
| 1 | FDS, finger flexors | volar | squeeze a fist, feel the belly bulge |
| 2 | EDC, finger extensors | dorsal | lift and spread the fingers |
| 4 | FCU | volar-ulnar | flex the wrist toward the pinky |

## Calibrating a new person

1. `python tools/live_server.py --active 1,2,4 --channels 1,2,4` → open
   <http://localhost:8901>. Check each channel's 60 Hz hum before recording: a good
   pad sits at 5–8 µV RMS at rest with hum under ~100 µV². A pad with poor contact
   carried **82 µV RMS of pure 60 Hz** — the same magnitude as a real contraction,
   so it has no usable range. Reseat it rather than filtering around it.
2. Record `rest` and `clench` with a few reps. Sessions land in `recordings/`.
3. `python tools/fit_weights.py recordings/session_*.parquet` → paste the printed
   `DEFAULT_WEIGHTS` into `emg_server.RealEmgSource`, or pass `--weights`.
4. In the app, run `calibrate_rest` then `calibrate_max` once per session.
   `calibration.py` maps the axis to 0..1 from that range — never hardcode a force
   threshold, amplitude varies by person, placement and session.

## Why the pipeline looks like this

**The filter carries state across chunks.** `DataFilter.perform_bandpass` filters
each `get_board_data()` chunk in isolation, and at a 40 Hz tick that chunk is ~3–6
samples — a 4th-order Butterworth over 3 samples never converges, so the "envelope"
is mostly startup transient. One cascaded SOS (60/120 Hz notch + 20–100 Hz band)
carries its `zi` between calls instead. No added latency, and phase distortion does
not matter underneath an RMS envelope.

The same bug in zero-phase form cost us a day: `filtfilt` was called without a
`padlen`, so its default ~24-sample padding could not absorb the step created by
extending a large electrode DC offset about the window endpoints. Resting channels
read **16,679 µV** where the true baseline was **5.58 µV**, and because the
scrolling buffer was re-filtered every frame the ringing stayed pinned to the buffer
ends and never scrolled out. It looked exactly like dead electrodes. If amplitudes
ever look impossible, check whether the hot region *scrolls* — pinned to the array
edges means filter artifact, not signal.

**The force axis is weighted, not averaged.** `mean(channels)` lets the worst
electrode dominate. Fisher separability for rest vs clench, leave-one-rep-out
cross-validated on a 60 s labelled session:

| axis | LORO CV Fisher |
|---|---|
| best single channel | 0.76 |
| unweighted sum | 0.86 |
| **LDA-weighted sum of log-envelopes** | **1.62** |

The fit is not what per-channel ranking suggests. **ch1 earns the largest weight
despite being the weakest channel alone** (Fisher 0.08 vs ch2's 0.44), and **ch4
earns a negative weight** — it is ~0.98 correlated with ch1, so it subtracts as a
common-mode reference. Picking "the best channel" discards both contributors.

Log-envelopes because sEMG amplitude is roughly log-normal, which is what makes
LDA's shared-covariance assumption reasonable.

**Screen dead channels before fitting.** A powered-down channel sits near-constant,
and its slow drift works as a *clock*; since rest and clench are recorded as
separate time blocks, a clock separates them perfectly. Fitting across all 8
channels handed the largest weight to a powered-down one and reported a *better*
score than the real fit. `fit_weights.py` drops channels whose active/rest ratio is
under 1.5 and reports cross-validated numbers for exactly this reason.

**EDC out-ranges FDS on a grip** (12.2× vs 6.3×) because wrist extensors
co-activate to stabilise against the flexor pull — corr(ch1, ch2) = +0.83 during
clench. So flexor *minus* extensor is the wrong axis for magnitude: they rise
together and the difference cancels where you want signal. Use the weighted sum for
magnitude; the difference is only useful for telling an actively-open hand from a
closed one.

**Trigger release on the envelope's negative slope, not its level.** EMG decays over
100–200 ms after a hard clench, so a level threshold fires late and at an
unpredictable moment. For anything that needs a crisp release, latch the peak as the
committed value and watch the rate of relaxation.

## Gotchas

- Serial is **single-owner**. `live_server.py` and `emg_server.py` cannot both hold
  the board; stop one before starting the other.
- After open, the dongle resets on DTR assert — wait ~1 s before writing, or the
  first command is swallowed and the board looks dead.
- If a process that owned the board is killed mid-stream, recover with `s` then `v`
  over serial at 115200.
- RF packet loss is normal (~1.9% on a 60 s session, worst gap 22 ms). Windowed
  training assumes contiguous samples, so interpolate or split across gaps;
  `_save_session` records a continuity report in the `.meta.json` sidecar.
