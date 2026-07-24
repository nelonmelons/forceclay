"""Throwaway smoke client: calibrate rest+max against a running emg_server.py, print messages."""

import asyncio
import json

import websockets

URL = "ws://localhost:6970"


async def main() -> None:
    async with websockets.connect(URL) as ws:
        await ws.send(json.dumps({"cmd": "calibrate_rest"}))
        print("sent calibrate_rest, waiting 1.5s...")
        await asyncio.sleep(1.5)

        await ws.send(json.dumps({"cmd": "calibrate_max"}))
        print("sent calibrate_max, waiting 1.5s...")
        await asyncio.sleep(1.5)

        # Messages kept arriving at ~40Hz during both sleeps (~3s) and queued up
        # in the socket's receive buffer (it's a continuous stream, so a
        # drain-until-timeout would never terminate). Drain a bounded backlog
        # so what we print next reflects current (post-calibration) state,
        # not stale early ticks from before calibration finished.
        BACKLOG_ESTIMATE = 200
        for _ in range(BACKLOG_ESTIMATE):
            await ws.recv()

        print("--- next 5 messages ---")
        for _ in range(5):
            raw = await ws.recv()
            print(raw)


if __name__ == "__main__":
    asyncio.run(main())
