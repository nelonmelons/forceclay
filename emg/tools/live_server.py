"""Localhost live EMG oscilloscope + cued labeled-data recorder for OpenBCI Cyton.

Owns the board via BrainFlow and serves a self-contained web page that:
  - plots Ch's filtered EMG waveform + moving-RMS envelope at display refresh,
  - runs a CUED protocol (Ninapro-style: on-screen prompts, fixed move/rest,
    N repetitions) that auto-labels the stream with label + repetition + phase,
  - also supports manual Start/Stop + label buttons,
  - on stop writes recordings/session_<ts>.parquet (all channels + label/rep/phase)
    + a metadata sidecar, ready for obci.features + train_gesture.py (LORO eval).

One process owns the serial port, so stop any CLI live_monitor first.

    python live_server.py --channel 1 --port 8765   # then open http://localhost:8765
"""
from __future__ import annotations

import argparse
import json
import threading
import time
from collections import Counter, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np

import sys as _sys, pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent.parent))  # emg/ -> obci

from obci import config
from obci import signal_processing as sp
from obci import decoder as D
from obci import coadapt_live
from live_monitor import compute_readout, EMG_DETECT_UV

PLOT_S = 30.0  # seconds of signal shown (scrolling window)

_state = {"lock": threading.Lock(), "fs": 250, "channels": [], "ch": {},
          "rec": {}, "pred": None, "classes": None}

_reclock = threading.Lock()
_rec = {"on": False, "label": "rest", "rep": 0, "phase": "idle", "t0": 0.0,
        "ts": [], "chans": {}, "labels": [], "reps": [], "phases": [], "chlist": [],
        "saved": True}


# ---- optional live classifier (npz from train_gesture.py --save-model) -----
_model = None

# ---- co-adaptation engine (Phase 1: live closed loop) ----------------------
CA = coadapt_live.CoAdapt()


class Model:
    def __init__(self, path):
        d = np.load(path, allow_pickle=True)
        self.classes = [str(c) for c in d["classes"]]
        self.mu, self.sd = d["mu"], d["sd"]
        self.cols = [str(c) for c in d["cols"]]
        self.W, self.B = d["W"], d["B"]          # (K,d), (K,)
        self.channels = sorted({int(c[2:].split("_")[0]) for c in self.cols})

    def predict(self, chan_windows, fs):
        from obci.features import window_features
        feat = {}
        for ch in self.channels:
            w = chan_windows.get(ch)
            if w is None or len(w) < 8:
                return None
            for name, val in window_features(w, fs).items():
                feat[f"ch{ch}_{name}"] = val
        x = np.array([feat.get(c, 0.0) for c in self.cols], dtype=float)
        x = np.nan_to_num((x - self.mu) / self.sd)
        s = self.W @ x + self.B
        e = np.exp(s - s.max())
        p = e / e.sum()
        k = int(np.argmax(s))
        return self.classes[k], float(p[k])


def _reset_capture(chlist):
    _rec.update(ts=[], labels=[], reps=[], phases=[], t0=time.time(),
                chans={ch: [] for ch in chlist}, chlist=list(chlist), saved=False)


def _save_session(fs, board):
    import pandas as pd
    with _reclock:
        n = len(_rec["ts"])
        if n == 0:
            return {"ok": False, "error": "no samples captured"}
        chlist = list(_rec["chlist"])
        cols = {"timestamp_s": np.asarray(_rec["ts"][:n], dtype=float)}
        for ch in chlist:
            cols[f"ch_{ch}"] = np.asarray(_rec["chans"][ch][:n], dtype=float)
        labels, reps, phases = _rec["labels"][:n], _rec["reps"][:n], _rec["phases"][:n]
    df = pd.DataFrame(cols)
    df["label"], df["rep"], df["phase"] = labels, reps, phases
    # data-quality: sample-continuity check (dropped RF packets -> time gaps that
    # would silently corrupt windows, since windowing assumes contiguous samples)
    ts = cols["timestamp_s"]
    gap = {"max_gap_ms": 0.0, "n_gaps": 0, "est_dropped": 0}
    if len(ts) > 1 and not np.all(ts == 0):
        d = np.diff(ts); dt = 1.0 / fs
        gap = {"max_gap_ms": round(float(d.max()) * 1000, 1),
               "n_gaps": int(np.sum(d > 2.5 * dt)),
               "est_dropped": int(np.maximum(0, np.round(d / dt - 1)).sum())}
    stamp = time.strftime("%Y%m%d_%H%M%S", time.localtime())
    path = config.DATA_DIR / f"session_{stamp}.parquet"
    df.to_parquet(path, index=False)
    with _reclock:
        _rec["saved"] = True
    counts = {str(k): int(v) for k, v in df["label"].value_counts().to_dict().items()}
    meta = {"fs": fs, "board": board, "channels": chlist, "n_samples": int(len(df)),
            "duration_s": round(len(df) / fs, 2), "labels": counts,
            "n_reps": int(max(reps) if reps else 0), "continuity": gap,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
            "source": "live_server"}
    path.with_suffix(".parquet.meta.json").write_text(json.dumps(meta, indent=2))
    return {"ok": True, "path": str(path), "n_samples": int(len(df)),
            "duration_s": meta["duration_s"], "labels": counts, "n_reps": meta["n_reps"],
            "dropped": gap["est_dropped"], "max_gap_ms": gap["max_gap_ms"]}


def _retrain():
    """Retrain on ALL sessions, hot-swap the live model, return leak-free eval."""
    global _model
    import glob
    paths = sorted(glob.glob(str(config.DATA_DIR / "session_*.parquet")))
    if not paths:
        return {"ok": False, "error": "no sessions recorded yet"}
    try:
        df = D.load_sessions(paths, [CHANNEL])
        if df.empty or df["label"].nunique() < 2:
            return {"ok": False, "error": "need >=2 gesture classes across sessions"}
        cols = D.feature_cols(df, [CHANNEL])
        group, name = D.choose_grouping(df)
        ev = D.evaluate(df, cols, group)
        mp = config.DATA_DIR / "live_model.npz"
        D.save_model(D.train(df, cols), mp)
        D.write_manifest(paths, df, config.DATA_DIR / "dataset_manifest.json")
        _model = Model(str(mp))
        rej = ev.get("reject") or {}
        return {"ok": True, "sessions": len(paths),
                "windows": int((df["aug"] == 0).sum()) if "aug" in df else int(len(df)),
                "classes": ev["classes"], "eval": name,
                "acc": round(ev["mean"] * 100, 1), "std": round(ev["std"] * 100, 1),
                "reject_acc": round(rej.get("acc", 0) * 100, 1),
                "reject_cov": round(rej.get("coverage", 0) * 100, 0),
                "hint": D.active_learning_hint(ev["confusion"], ev["classes"])}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _acquire(bridge, display, fs):
    bridge.start_stream()
    eeg = bridge.eeg_channels()
    ts_row = bridge._timestamp_channel()
    shim = bridge._shim
    plot_n = int(PLOT_S * fs)
    inf_n = int(0.30 * fs)
    win_n = max(8, int(config.EMG_WINDOW_S * fs))   # match training window (config)
    display = [d for d in display if 1 <= d <= len(eeg)] or [1]
    plot_bufs = {d: [] for d in display}             # one scrolling buffer per shown channel
    infer_bufs = {i + 1: [] for i in range(len(eeg))}
    votes = deque(maxlen=5)
    committed = None
    CONF_GATE = 0.6        # below this, the window is ambiguous (e.g. a transition)
    ca_n = 0               # throttle counter for co-adaptation ingest
    while True:
        try:
            data = shim.get_board_data()
            m = data.shape[1] if (getattr(data, "ndim", 0) == 2) else 0
            if m > 0:
                for d in display:
                    pb = plot_bufs[d]
                    pb.extend(data[eeg[d - 1]].tolist())
                    if len(pb) > plot_n:
                        del pb[:-plot_n]
                for k, row in enumerate(eeg):
                    b = infer_bufs[k + 1]
                    b.extend(data[row].tolist())
                    if len(b) > inf_n:
                        del b[:-inf_n]
                with _reclock:
                    if _rec["on"]:
                        ts = data[ts_row].tolist() if data.shape[0] > ts_row else [0.0] * m
                        for k, row in enumerate(eeg):
                            _rec["chans"][k + 1].extend(data[row].tolist())
                        _rec["ts"].extend(ts)
                        _rec["labels"].extend([_rec["label"]] * m)
                        _rec["reps"].extend([_rec["rep"]] * m)
                        _rec["phases"].extend([_rec["phase"]] * m)
                    rec = {"recording": _rec["on"], "label": _rec["label"],
                           "phase": _rec["phase"], "rep": _rec["rep"],
                           "rec_n": len(_rec["ts"]), "rec_s": round(len(_rec["ts"]) / fs, 1)}
                    # Autosave watcher: catches ANY on->off transition that left data
                    # behind, not just the manual /record/stop route. A cued protocol
                    # that finished its reps used to strand the whole session in RAM
                    # until the next restart threw it away.
                    needs_save = (not _rec["on"]) and len(_rec["ts"]) > 0 \
                        and not _rec["saved"]
                if needs_save:
                    try:
                        r = _save_session(fs, BOARD)
                        print(f"[autosave] {r.get('path')}  n={r.get('n_samples')} "
                              f"labels={r.get('labels')}", flush=True)
                    except Exception as e:      # never let a save fault spin the loop
                        with _reclock:
                            _rec["saved"] = True
                        print(f"[autosave] FAILED: {e}", flush=True)

                rn = int(1.5 * fs)                       # readout reflects recent activity
                edge = int(0.25 * fs)                    # filtfilt ringing at both ends
                chpay = {}
                for d in display:
                    x = np.asarray(plot_bufs[d], dtype=float)
                    pre = sp.preprocess_emg(x, fs)
                    # Drop the filter's edge transient rather than plotting it. It is
                    # pinned to the buffer ends, so it never scrolls out, and it was
                    # swamping both the trace and every amplitude statistic.
                    if pre.size > 4 * edge:
                        pre = pre[edge:-edge]
                    env = sp.emg_envelope(pre, fs)
                    # Hand the readout a window that is `edge` longer on each side than
                    # the 1.5 s it is meant to measure, so the trim lands on padding.
                    want = rn + 2 * edge
                    ro = compute_readout(x[-want:] if x.size > want else x, fs, trim=edge)
                    step = max(1, pre.size // 600)
                    chpay[d] = {
                        "wave": [round(float(v), 2) for v in pre[::step]],
                        "env": [round(float(v), 2) for v in env[::step]],
                        "readout": {
                            "raw_rms": round(float(ro["raw_rms"]), 1),
                            "emg_rms": round(float(ro["emg_rms"]), 1),
                            "emg_peak": round(float(ro["emg_peak"]), 1),
                            "hum_uv2": round(float(ro["hum_uv2"]), 1),
                            "burst": bool(ro["emg_peak"] >= EMG_DETECT_UV),
                        },
                    }
                pred = None
                if _model is not None:
                    cw = {ch: np.asarray(infer_bufs[ch][-win_n:], dtype=float)
                          for ch in _model.channels if ch in infer_bufs}
                    if all(len(cw.get(ch, [])) >= win_n for ch in _model.channels):
                        r = _model.predict(cw, fs)
                        if r:
                            top, conf = r
                            votes.append(top)
                            cand, cnt = Counter(votes).most_common(1)[0]
                            # commit a switch only on confident, consistent agreement;
                            # transition windows are out-of-distribution -> low conf -> hold
                            if conf >= CONF_GATE and cnt >= 4:
                                committed = cand
                            pred = {"label": committed or top, "conf": round(conf, 2),
                                    "stable": bool(committed == cand and conf >= CONF_GATE)}
                with _state["lock"]:
                    _state["fs"] = fs
                    _state["channels"] = list(display)
                    _state["ch"] = chpay
                    _state["rec"] = rec
                    _state["pred"] = pred
                    _state["classes"] = (_model.classes if _model is not None else None)
                # --- co-adaptation: feed one window every ~3 ticks (predict-before-learn) ---
                ca_n += 1
                if CA.on and ca_n % 3 == 0:
                    cw = {ch: infer_bufs[ch][-win_n:] for ch in display
                          if len(infer_bufs[ch]) >= win_n}
                    if len(cw) == len(display):
                        CA.ingest(cw, fs)
        except Exception:
            time.sleep(0.3)
        time.sleep(0.02)


PAGE = r"""<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Neuromotor Monitor · Ch {CHS}</title><style>
 :root{--bg:#000;--surf:#0c0c0c;--bd:#1a1a1a;--bd2:#2e2e2e;--bd3:#3d3d3d;--fg:#ededed;--mut:#a1a1a1;--dim:#666;--raw:#5aa9e6;--env:#e0a13a}
 *{box-sizing:border-box}
 html,body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
 .mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
 #wrap{max-width:920px;margin:0 auto;padding:30px 24px 64px}
 header{display:flex;align-items:center;justify-content:space-between;padding-bottom:16px;border-bottom:1px solid var(--bd)}
 .brand{font-weight:600;font-size:14px;letter-spacing:-.01em}
 .brand .sub{color:var(--dim);font-weight:400}
 .pill{font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
 .chart{padding:20px 0 4px}
 .chart-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
 .chart-hd .t{font-size:11px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
 .right{display:flex;align-items:center;gap:16px}
 .legend{display:flex;gap:13px;font-size:11px;color:var(--mut)}
 .legend i{display:inline-block;width:11px;height:2px;margin-right:5px;vertical-align:middle;border-radius:1px}
 canvas{width:100%;height:300px;display:block}
 .axis{display:flex;justify-content:space-between;font-size:11px;color:var(--dim);padding-top:8px}
 .verdict{font-size:12px;font-weight:500;color:var(--mut)}
 .clean{color:#666!important}.burst{color:#ededed!important}.hum{color:#ededed!important}
 .chart+.chart{border-top:1px solid var(--bd);margin-top:6px;padding-top:8px}
 .stats{display:grid;grid-template-columns:repeat(4,1fr);margin-top:18px;border-top:1px solid var(--bd);padding-top:16px}
 .stat{padding-left:18px;border-left:1px solid var(--bd)}
 .stat:first-child{padding-left:0;border-left:0}
 .stat .k{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
 .stat .v{font-size:23px;font-weight:600;margin-top:7px;letter-spacing:-.02em;color:var(--fg)}
 .stat .v u{font-size:12px;color:var(--dim);font-weight:400;text-decoration:none;margin-left:3px}
 #pred{display:none;margin-top:18px;padding:14px 16px;border-radius:10px;background:var(--surf);align-items:center}
 #pred .lab{font-size:18px;font-weight:600;color:var(--fg);letter-spacing:-.01em}
 #pred .c{margin-left:auto;font-size:12px;color:var(--dim)}
 #cue{display:none;text-align:center;font-size:30px;font-weight:700;letter-spacing:-.02em;padding:22px;border-radius:10px;margin-top:18px;background:var(--surf);color:var(--fg)}
 .cue-prep{color:var(--mut)!important}.cue-move{color:#fff!important}.cue-rest{color:var(--dim)!important}
 .sec{margin-top:22px;padding-top:20px;border-top:1px solid var(--bd)}
 .sec h2{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:0 0 14px;font-weight:600}
 .rowf{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
 label{color:var(--mut);font-size:12px;display:inline-flex;align-items:center;gap:6px}
 input{font:inherit;font-size:13px;color:var(--fg);background:var(--surf);border:1px solid var(--bd2);border-radius:6px;height:34px;padding:0 10px;outline:none;transition:border-color .12s}
 input:focus{border-color:var(--bd3)}
 button{font:inherit;font-size:14px;font-weight:500;color:var(--fg);background:transparent;border:1px solid var(--bd2);border-radius:6px;height:34px;padding:0 13px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:color .12s,border-color .12s,background .12s}
 button:hover{background:#161616;border-color:var(--bd3)}
 button.active{border-color:var(--bd3);background:#161616}
 button.go{background:#ededed;color:#000;border-color:#ededed}
 button.go:hover{background:#fff;border-color:#fff}
 .lblbtn{color:var(--mut)}.lblbtn.on{color:var(--fg);border-color:var(--bd3);background:#161616}
 .catg{color:var(--mut)}.catg.on{color:var(--fg);border-color:var(--bd3);background:#161616}
 #ca_canvas{width:100%;height:340px;display:block;background:#070707;border-radius:8px}
 #recinfo{margin-left:auto;color:var(--dim);font-size:12px;text-align:right;max-width:55%}
 small{color:var(--dim);font-size:11.5px;display:block;margin-top:20px;line-height:1.6}
</style></head><body><div id=wrap>
 <header>
  <div class=brand>Neuromotor Monitor <span class=sub>· Cyton Ch {CHS}</span></div>
  <span class=pill><span id=fps>– fps</span></span>
 </header>
 <div id=charts></div>
 <div id=cue></div>
 <div id=pred><span class=lab>—</span><span class="c mono"></span></div>
 <div class=sec>
  <h2>Cued protocol · auto-labeled</h2>
  <div class=rowf>
   <label>gestures <input id=pg value="clench,point" size=18></label>
   <label>reps <input id=preps value=5 size=2></label>
   <label>move <input id=pmv value=3 size=2></label>
   <label>rest <input id=prs value=2 size=2></label>
   <label>prep <input id=ppp value=1 size=2></label>
   <button class=go id=protobtn onclick=runProto()>Run protocol</button>
   <button onclick=retrainNow()>Retrain</button>
  </div>
 </div>
 <div class=sec>
  <h2>Manual record</h2>
  <div class=rowf>
   <button id=recbtn onclick=toggleRec()>Start recording</button>
   <span style="color:var(--mut)">label</span><span id=lblbtns></span>
   <input id=newlbl placeholder="new label…" size=11 onkeydown="if(event.key==='Enter')addLbl()">
   <button onclick=addLbl()>+ add</button>
   <span id=recinfo></span>
  </div>
 </div>
 <div class=sec>
  <h2>Co-adaptation · live closed loop (Phase 1)</h2>
  <div class=rowf>
   <span style="color:var(--mut)">target</span>
   <button class=catg data-l=rest onclick="caTarget('rest')">rest</button>
   <button class=catg data-l=clench onclick="caTarget('clench')">clench</button>
   <button class=catg data-l=point onclick="caTarget('point')">point</button>
   <button class=go id=cabtn onclick=caToggle()>Start co-adapt</button>
   <button onclick=caReset()>Reset</button>
   <span id=ca_state style="margin-left:auto;color:var(--dim)">idle</span>
  </div>
  <canvas id=ca_canvas></canvas>
  <div class=axis><span class=mono>LDA discriminant space — steer your live dot (○) into its cluster</span><span></span></div>
  <div class=stats>
   <div class=stat><div class=k>prequential acc</div><div class="v mono" id=ca_preq>–</div></div>
   <div class=stat><div class=k>separability</div><div class="v mono" id=ca_sep>–</div></div>
   <div class=stat><div class=k>windows</div><div class="v mono" id=ca_n>0</div></div>
   <div class=stat><div class=k>target</div><div class="v mono" id=ca_tgt>–</div></div>
  </div>
 </div>
 <small>Saves labeled Parquet → recordings/ · auto-retrains on completion · burst threshold {THR} µV · render ≤120 fps · signal 250 Hz</small>
</div><script>
let labelsList=['rest','clench'],current='rest',recording=false,protoRunning=false;
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
const chartsEl=document.getElementById('charts');const panels={};
function buildPanel(ch){
 const w=document.createElement('div');w.className='chart';
 w.innerHTML='<div class=chart-hd><span class=t>EMG · Channel '+ch+'</span>'
  +'<span class=right><span class=legend><span><i style="background:var(--raw)"></i>signal</span><span><i style="background:var(--env)"></i>envelope</span></span><span class="verdict clean">…</span></span></div>'
  +'<canvas></canvas><div class=axis><span class="axL mono">±0 µV</span><span>30 s window</span></div>'
  +'<div class=stats><div class=stat><div class=k>EMG peak</div><div class="v mono pk">–</div></div>'
  +'<div class=stat><div class=k>EMG rms</div><div class="v mono rms">–</div></div>'
  +'<div class=stat><div class=k>60 Hz hum</div><div class="v mono hum">–</div></div>'
  +'<div class=stat><div class=k>raw rms</div><div class="v mono raw">–</div></div></div>';
 chartsEl.appendChild(w);
 const cv=w.querySelector('canvas');
 const p={cv:cv,x:cv.getContext('2d'),pk:w.querySelector('.pk'),rms:w.querySelector('.rms'),
  hum:w.querySelector('.hum'),raw:w.querySelector('.raw'),verdict:w.querySelector('.verdict'),axL:w.querySelector('.axL')};
 const fit=()=>{cv.width=cv.clientWidth*devicePixelRatio;cv.height=cv.clientHeight*devicePixelRatio;};
 fit();addEventListener('resize',fit);panels[ch]=p;return p;
}
function renderLbls(){const h=document.getElementById('lblbtns');h.innerHTML='';
 labelsList.forEach(L=>{const b=document.createElement('button');b.textContent=L;b.className='lblbtn'+(L===current?' on':'');b.onclick=()=>setLabel(L);h.appendChild(b);});}
async function setLabel(L){current=L;renderLbls();try{await fetch('/cue?label='+encodeURIComponent(L)+'&rep=0&phase=manual');}catch(e){}}
function addLbl(){const v=document.getElementById('newlbl').value.trim();if(v&&!labelsList.includes(v)){labelsList.push(v);document.getElementById('newlbl').value='';}setLabel(v||current);}
async function toggleRec(){if(protoRunning)return;recording=!recording;const b=document.getElementById('recbtn');
 if(recording){await fetch('/record/start');b.textContent='■ Stop & save';b.className='active';}
 else{b.textContent='Start recording';b.className='';const r=await(await fetch('/record/stop')).json();
  document.getElementById('recinfo').textContent=r.ok?('saved '+r.n_samples+' samp → '+r.path.split('/').pop()):('save: '+(r.error||'?'));}}
async function runProto(){
 if(protoRunning||recording)return;protoRunning=true;
 const gestures=document.getElementById('pg').value.split(',').map(s=>s.trim()).filter(Boolean);
 const reps=+document.getElementById('preps').value,mv=+document.getElementById('pmv').value,rs=+document.getElementById('prs').value,pp=+document.getElementById('ppp').value;
 const steps=[];for(let r=1;r<=reps;r++){for(const g of gestures){
   steps.push({label:g,phase:'prep',sec:pp,rep:r,t:'get ready… '+g});
   steps.push({label:g,phase:'move',sec:mv,rep:r,t:g.toUpperCase()});
   steps.push({label:'rest',phase:'rest',sec:rs,rep:r,t:'rest'});}}
 document.getElementById('protobtn').textContent='recording…';
 await fetch('/record/start');const cue=document.getElementById('cue');cue.style.display='block';
 for(let i=0;i<steps.length;i++){const s=steps[i];cue.className='cue-'+s.phase;
   await fetch('/cue?label='+encodeURIComponent(s.label)+'&rep='+s.rep+'&phase='+s.phase);
   for(let t=s.sec;t>0;t--){cue.textContent=s.t+'  ('+t+')   ·   rep '+s.rep+'/'+reps+'   ['+(i+1)+'/'+steps.length+']';await sleep(1000);}}
 cue.style.display='none';const res=await(await fetch('/record/stop')).json();
 document.getElementById('protobtn').textContent='Run protocol';protoRunning=false;
 const ri=document.getElementById('recinfo');
 if(res.ok){ri.textContent='✓ saved '+res.n_samples+' samp, '+res.n_reps+' reps · retraining…';
   const rt=await(await fetch('/retrain')).json();
   ri.textContent=rt.ok?('✓ '+rt.eval+': '+rt.acc+'% ±'+rt.std+'% · ['+rt.classes.join(', ')+'] · next: '+rt.hint):('saved; retrain: '+(rt.error||''));}
 else ri.textContent='save err '+(res.error||'');}
async function retrainNow(){const ri=document.getElementById('recinfo');ri.textContent='retraining…';
 const rt=await(await fetch('/retrain')).json();
 ri.textContent=rt.ok?('✓ '+rt.eval+': '+rt.acc+'% ±'+rt.std+'% (reject '+rt.reject_acc+'%@'+rt.reject_cov+'%) · ['+rt.classes.join(', ')+'] · next: '+rt.hint):('retrain: '+(rt.error||''));}
function draw(p,wave,env){const c=p.cv,x=p.x,W=c.width,H=c.height,mid=H/2,dpr=devicePixelRatio,N=env.length,M=wave.length;
 if(N<2||M<2)return;x.clearRect(0,0,W,H);
 let m=8;for(const v of wave)if(Math.abs(v)>m)m=Math.abs(v);for(const v of env)if(v>m)m=v;
 const sc=(H*0.44)/m,px=i=>i/(N-1)*W;
 x.strokeStyle='rgba(255,255,255,.05)';x.lineWidth=1;
 for(let g=1;g<4;g++){const yy=H*g/4;x.beginPath();x.moveTo(0,yy);x.lineTo(W,yy);x.stroke();}
 // envelope = muscle activation, filled amber band
 const grad=x.createLinearGradient(0,0,0,H);
 grad.addColorStop(0,'rgba(224,161,58,0)');grad.addColorStop(.5,'rgba(224,161,58,.15)');grad.addColorStop(1,'rgba(224,161,58,0)');
 x.beginPath();x.moveTo(0,mid-env[0]*sc);
 for(let i=1;i<N;i++)x.lineTo(px(i),mid-env[i]*sc);
 for(let i=N-1;i>=0;i--)x.lineTo(px(i),mid+env[i]*sc);
 x.closePath();x.fillStyle=grad;x.fill();
 // raw signal = blue, underneath
 x.strokeStyle='rgba(90,169,230,.58)';x.lineWidth=1*dpr;x.beginPath();
 for(let i=0;i<M;i++){const y=mid-wave[i]*sc;i?x.lineTo(i/(M-1)*W,y):x.moveTo(0,y);}x.stroke();
 // envelope edges = amber, on top
 x.strokeStyle='rgba(224,161,58,.92)';x.lineWidth=1.4*dpr;
 x.beginPath();for(let i=0;i<N;i++){const y=mid-env[i]*sc;i?x.lineTo(px(i),y):x.moveTo(px(i),y);}x.stroke();
 x.beginPath();for(let i=0;i<N;i++){const y=mid+env[i]*sc;i?x.lineTo(px(i),y):x.moveTo(px(i),y);}x.stroke();
 p.axL.textContent='±'+m.toFixed(0)+' µV';}
let latest=null;
async function poll(){try{latest=await(await fetch('/data',{cache:'no-store'})).json();}catch(e){}setTimeout(poll,16);}
let frames=0,lastT=performance.now();
function render(){if(latest&&latest.channels){
  latest.channels.forEach(ch=>{
   const p=panels[ch]||buildPanel(ch),cd=(latest.ch||{})[ch];if(!cd)return;
   const o=cd.readout||{},burst=o.burst,hum=o.hum_uv2>350;
   if(cd.wave&&cd.wave.length)draw(p,cd.wave,cd.env);
   p.pk.innerHTML=(o.emg_peak??'–')+'<u>µV</u>';p.rms.innerHTML=(o.emg_rms??'–')+'<u>µV</u>';
   p.hum.innerHTML=(o.hum_uv2??'–')+'<u>µV²</u>';p.raw.innerHTML=(o.raw_rms??'–')+'<u>µV</u>';
   if(burst){p.verdict.className='verdict burst';p.verdict.textContent='EMG burst · '+o.emg_peak+' µV';}
   else if(hum){p.verdict.className='verdict hum';p.verdict.textContent='Hum '+Math.round(o.hum_uv2)+' µV² · fix contact';}
   else{p.verdict.className='verdict clean';p.verdict.textContent='Clean';}
  });
  const pr=document.getElementById('pred');
  if(latest.pred){pr.style.display='flex';pr.querySelector('.lab').textContent=(latest.pred.stable?'':'… ')+latest.pred.label.toUpperCase();
   pr.querySelector('.c').textContent=Math.round(latest.pred.conf*100)+'% confidence';pr.style.opacity=latest.pred.stable?'1':'.55';}
  else pr.style.display='none';
  const rc=latest.rec||{};
  if(rc.recording&&!protoRunning)document.getElementById('recinfo').textContent='● REC '+rc.rec_s+'s · '+rc.rec_n+' samp · '+rc.label;}
 frames++;const now=performance.now();
 if(now-lastT>=500){document.getElementById('fps').textContent=Math.round(frames*1000/(now-lastT))+' fps';frames=0;lastT=now;}
 requestAnimationFrame(render);}
renderLbls();poll();requestAnimationFrame(render);
// ---- co-adaptation panel ----
let caOn=false;
const cac=document.getElementById('ca_canvas'),cax=cac.getContext('2d');
function cafit(){cac.width=cac.clientWidth*devicePixelRatio;cac.height=cac.clientHeight*devicePixelRatio;}
cafit();addEventListener('resize',cafit);
const CACOL={clench:'#5aa9e6',point:'#e0a13a',rest:'#888'};
const cacol=l=>CACOL[l]||'#ededed';
async function caTarget(l){await fetch('/coadapt/target?label='+encodeURIComponent(l));
 document.querySelectorAll('.catg').forEach(b=>b.classList.toggle('on',b.dataset.l===l));document.getElementById('ca_tgt').textContent=l;}
async function caToggle(){caOn=!caOn;await fetch('/coadapt/'+(caOn?'start':'stop'));
 document.getElementById('cabtn').textContent=caOn?'■ Stop co-adapt':'Start co-adapt';document.getElementById('cabtn').className=caOn?'active':'go';}
async function caReset(){await fetch('/coadapt/reset');}
function caDraw(s){const W=cac.width,H=cac.height;cax.clearRect(0,0,W,H);
 const pts=s.proj||[],cent=s.cent||{},live=s.live;
 let all=pts.map(p=>[p[0],p[1]]);Object.values(cent).forEach(c=>all.push(c));if(live)all.push(live);
 if(all.length<2){cax.fillStyle='#444';cax.font=(13*devicePixelRatio)+'px sans-serif';cax.fillText('hold a target gesture to start building the map…',20,30*devicePixelRatio);return;}
 const xs=all.map(a=>a[0]),ys=all.map(a=>a[1]);
 let x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
 const px=0.12*Math.max(x1-x0,1e-3),py=0.12*Math.max(y1-y0,1e-3);x0-=px;x1+=px;y0-=py;y1+=py;
 const sx=v=>(v-x0)/(x1-x0+1e-9)*W,sy=v=>H-(v-y0)/(y1-y0+1e-9)*H;
 for(const p of pts){cax.fillStyle=cacol(p[2]);cax.globalAlpha=.3;cax.beginPath();cax.arc(sx(p[0]),sy(p[1]),3*devicePixelRatio,0,7);cax.fill();}
 cax.globalAlpha=1;
 for(const k in cent){const c=cent[k];cax.strokeStyle=cacol(k);cax.lineWidth=2.5*devicePixelRatio;cax.beginPath();cax.arc(sx(c[0]),sy(c[1]),11*devicePixelRatio,0,7);cax.stroke();
  cax.fillStyle=cacol(k);cax.font=(12*devicePixelRatio)+'px sans-serif';cax.fillText(k,sx(c[0])+14*devicePixelRatio,sy(c[1])+4*devicePixelRatio);}
 if(live){cax.fillStyle='#fff';cax.beginPath();cax.arc(sx(live[0]),sy(live[1]),5*devicePixelRatio,0,7);cax.fill();
  cax.strokeStyle='#fff';cax.lineWidth=1.5*devicePixelRatio;cax.beginPath();cax.arc(sx(live[0]),sy(live[1]),13*devicePixelRatio,0,7);cax.stroke();}}
async function caPoll(){try{const s=await(await fetch('/coadapt/state',{cache:'no-store'})).json();
 caDraw(s);
 document.getElementById('ca_preq').innerHTML=(s.preq==null?'–':s.preq+'<u>%</u>');
 document.getElementById('ca_sep').textContent=(s.sep==null?'–':s.sep);
 document.getElementById('ca_n').textContent=s.n||0;
 document.getElementById('ca_state').textContent=s.on?('● adapting'+(s.target?' → '+s.target:' (set a target)')):'idle';
}catch(e){}setTimeout(caPoll,200);}
caPoll();
</script></body></html>"""


CHANNEL, FS, BOARD, _eeg, _display = 1, 250, "cyton", [], [1]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj):
        self._send(json.dumps(obj).encode(), "application/json")

    def do_GET(self):
        p = urlparse(self.path)
        q = parse_qs(p.query)
        if p.path == "/data":
            with _state["lock"]:
                self._json({"fs": _state["fs"], "channels": _state["channels"],
                            "ch": _state["ch"], "rec": _state["rec"],
                            "pred": _state["pred"], "classes": _state["classes"]})
        elif p.path == "/cue":
            with _reclock:
                _rec["label"] = (q.get("label", ["rest"])[0])[:40] or "rest"
                _rec["rep"] = int(q.get("rep", ["0"])[0] or 0)
                _rec["phase"] = (q.get("phase", ["manual"])[0])[:16]
            self._json({"ok": True, "label": _rec["label"], "rep": _rec["rep"], "phase": _rec["phase"]})
        elif p.path == "/record/start":
            with _reclock:
                _reset_capture(list(range(1, len(_eeg) + 1)))
                _rec["on"] = True
            self._json({"ok": True})
        elif p.path == "/record/stop":
            with _reclock:
                _rec["on"] = False
            self._json(_save_session(FS, BOARD))
        elif p.path == "/retrain":
            self._json(_retrain())
        elif p.path == "/coadapt/start":
            CA.start(); self._json({"ok": True})
        elif p.path == "/coadapt/stop":
            CA.stop(); self._json({"ok": True})
        elif p.path == "/coadapt/reset":
            CA.reset(); self._json({"ok": True})
        elif p.path == "/coadapt/target":
            CA.set_target((q.get("label", [""])[0])[:40]); self._json({"ok": True, "target": CA.target})
        elif p.path == "/coadapt/state":
            self._json(CA.state())
        else:
            chs = ",".join(str(c) for c in _display) or str(CHANNEL)
            self._send(PAGE.replace("{CHS}", chs).replace("{THR}", str(int(EMG_DETECT_UV))).encode(),
                       "text/html; charset=utf-8")


def main() -> int:
    global CHANNEL, FS, BOARD, _eeg, _model, _display
    ap = argparse.ArgumentParser(description="Localhost live EMG oscilloscope + cued recorder")
    ap.add_argument("--channel", type=int, default=1)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--serial", default=config.DEFAULT_SERIAL_PORT)
    ap.add_argument("--board", default=config.DEFAULT_BOARD)
    ap.add_argument("--model", default=None, help="npz from train_gesture.py --save-model (live inference)")
    ap.add_argument("--active", default=None,
                    help="comma list of channels to keep powered ON, e.g. 1,2 — "
                         "powers down the rest so unused inputs don't pollute BIAS")
    ap.add_argument("--channels", default=None,
                    help="comma list of channels to DISPLAY, e.g. 1,2 (default: --active or --channel)")
    args = ap.parse_args()
    CHANNEL, BOARD = args.channel, args.board
    if args.model:
        _model = Model(args.model)
        print(f"loaded model: classes={_model.classes}  channels={_model.channels}")

    from obci.bridge import CytonBridge, BridgeError
    active = [int(c) for c in args.active.split(",") if c.strip()] if args.active else None
    if args.channels:
        _display = [int(c) for c in args.channels.split(",") if c.strip()]
    else:
        _display = active or [args.channel]
    print(f"displaying channels: {_display}")

    # Bind and serve BEFORE touching the board. A failed RF handshake used to exit
    # here, so the browser got a connection error rather than a graph -- which reads
    # as "wrong port" when it is really "board not answering". Now the page loads
    # immediately and starts drawing as soon as the board comes up.
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"LIVE recorder at  http://localhost:{args.port}   "
          f"(Ch{_display}) — page is live, waiting for board.  Ctrl-C to stop", flush=True)

    bridge = None
    try:
        while bridge is None:
            b = CytonBridge(args.serial, args.board)
            try:
                b.start_stream(active=active)
            except BridgeError as e:
                print(f"  board not ready ({e}) — retrying in 5s", flush=True)
                time.sleep(5)
                continue
            bridge = b
            FS = b.sampling_rate
            _eeg = b.eeg_channels()
            with _state["lock"]:
                _state["fs"] = FS
                _state["channels"] = list(_display)
            if active:
                print(f"active channels (BIAS-driving): {active}  — others powered down")
            print(f"STREAMING Ch{_display} @ {FS} Hz, {len(_eeg)} board ch", flush=True)
            threading.Thread(target=_acquire, args=(bridge, _display, FS), daemon=True).start()
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\nstopping…")
    finally:
        srv.shutdown()
        srv.server_close()
        if bridge is not None:
            bridge.release()
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
