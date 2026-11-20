#!/usr/bin/env python3
"""Optional helper: expose a localhost-only Review Desk on one other interface.

The desk binds 127.0.0.1 by default and has no authentication. If you reach it
over a private network that already authenticates and encrypts traffic (a VPN,
a WireGuard or Tailscale-style overlay, an SSH tunnel endpoint), this forwards
TCP connections from that interface's address to the desk on 127.0.0.1.

    python3 examples/tcpfwd.py --listen 10.8.0.5:8471 --target 127.0.0.1:8471

Bind a specific private address, never 0.0.0.0: anyone who can reach the listen
address can read and answer every item. On an untrusted network, use a reverse
proxy with authentication and TLS instead.
"""
import argparse
import asyncio
import sys


def hostport(s):
    host, _, port = s.rpartition(":")
    if not host or not port.isdigit():
        raise argparse.ArgumentTypeError(f"expected HOST:PORT, got {s!r}")
    return host.strip("[]"), int(port)


async def pipe(r, w):
    try:
        while data := await r.read(65536):
            w.write(data)
            await w.drain()
    except Exception:  # noqa: BLE001
        pass
    finally:
        try:
            w.close()
        except Exception:  # noqa: BLE001
            pass


async def main(listen, target):
    async def handle(cr, cw):
        try:
            tr, tw = await asyncio.open_connection(*target)
        except OSError:
            cw.close()
            return
        await asyncio.gather(pipe(cr, tw), pipe(tr, cw))

    srv = await asyncio.start_server(handle, *listen)
    print(f"tcpfwd: {listen[0]}:{listen[1]} -> {target[0]}:{target[1]}", flush=True)
    async with srv:
        await srv.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--listen", type=hostport, required=True, help="HOST:PORT to listen on (a private address)")
    ap.add_argument("--target", type=hostport, default=("127.0.0.1", 8471), help="desk address (default 127.0.0.1:8471)")
    a = ap.parse_args()
    if a.listen[0] in ("0.0.0.0", "::", ""):
        sys.exit("tcpfwd: refusing to listen on every interface; pass one private address")
    try:
        asyncio.run(main(a.listen, a.target))
    except KeyboardInterrupt:
        pass
