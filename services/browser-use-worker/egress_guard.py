"""Egress guard for the browser worker (security audit 2026-11-24, H2).

Chromium used to talk to the network directly, and only the first URL of a job was checked. A public page could
redirect the browser to an internal service, fetch one from JavaScript, or rebind its own DNS name to a private
address after the check. Every connection Chromium makes now goes through this local forward proxy, which resolves
the host itself, refuses any non-public address, and connects to the address it validated (no second lookup).
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

ALLOWED_PORTS = {80, 443, 8080, 8443}
MAX_HEADER_BYTES = 64 * 1024
CONNECT_TIMEOUT_SECONDS = 15


class EgressDenied(Exception):
    pass


def is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if isinstance(ip, ipaddress.IPv6Address) and (ip.sixtofour is not None or ip.teredo is not None):
        return False
    return ip.is_global and not ip.is_multicast and not ip.is_reserved


async def resolve_public(host: str, port: int) -> str:
    """Resolves the host and returns an address to connect to; refuses if ANY address is not public."""
    if port not in ALLOWED_PORTS:
        raise EgressDenied(f"port {port} is not allowed")
    host = host.strip("[]").rstrip(".").lower()
    if not host:
        raise EgressDenied("empty host")
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise EgressDenied("destination could not be resolved") from exc
    addresses = [info[4][0] for info in infos]
    if not addresses or not all(is_public_address(address) for address in addresses):
        raise EgressDenied("destination resolves to a protected network")
    return addresses[0]


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def _refuse(writer: asyncio.StreamWriter, reason: str) -> None:
    body = f"Blocked by NPATI browser egress policy: {reason}\n".encode()
    writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: "
                 + str(len(body)).encode() + b"\r\n\r\n" + body)
    try:
        await writer.drain()
    finally:
        writer.close()


async def _handle(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
    try:
        head = await asyncio.wait_for(client_reader.readuntil(b"\r\n\r\n"), timeout=30)
    except Exception:
        client_writer.close()
        return
    if len(head) > MAX_HEADER_BYTES:
        await _refuse(client_writer, "request header too large")
        return
    lines = head.decode("latin-1").split("\r\n")
    try:
        method, target, version = lines[0].split(" ", 2)
    except ValueError:
        await _refuse(client_writer, "malformed request")
        return
    try:
        if method.upper() == "CONNECT":
            host, _, port_text = target.rpartition(":")
            port = int(port_text)
            address = await resolve_public(host, port)
            upstream_reader, upstream_writer = await asyncio.wait_for(asyncio.open_connection(address, port), CONNECT_TIMEOUT_SECONDS)
            client_writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await client_writer.drain()
        else:
            url = urlsplit(target)
            if url.scheme != "http" or not url.hostname:
                raise EgressDenied("only absolute http URLs may be proxied")
            port = url.port or 80
            address = await resolve_public(url.hostname, port)
            upstream_reader, upstream_writer = await asyncio.wait_for(asyncio.open_connection(address, port), CONNECT_TIMEOUT_SECONDS)
            path = url.path or "/"
            if url.query:
                path += "?" + url.query
            # One request per upstream connection: a reused proxy connection could otherwise carry a request for another
            # host to this validated address.
            headers = [line for line in lines[1:] if line and not line.lower().startswith(("proxy-connection:", "connection:", "keep-alive:"))]
            request = f"{method} {path} {version}\r\n" + "\r\n".join(headers + ["Connection: close"]) + "\r\n\r\n"
            upstream_writer.write(request.encode("latin-1"))
            await upstream_writer.drain()
    except EgressDenied as exc:
        await _refuse(client_writer, str(exc))
        return
    except (ValueError, OSError, asyncio.TimeoutError):
        await _refuse(client_writer, "upstream unavailable")
        return
    await asyncio.gather(_pipe(client_reader, upstream_writer), _pipe(upstream_reader, client_writer))


_server: asyncio.AbstractServer | None = None
_lock = asyncio.Lock()


async def ensure_egress_proxy() -> str:
    """Starts the guard once per process on a loopback port and returns its proxy URL."""
    global _server
    async with _lock:
        if _server is None:
            _server = await asyncio.start_server(_handle, "127.0.0.1", 0)
        port = _server.sockets[0].getsockname()[1]
    return f"http://127.0.0.1:{port}"


# Chromium bypasses a proxy for loopback by default; "<-loopback>" removes that exception so even 127.0.0.1 is checked.
PROXY_BYPASS = "<-loopback>"
# WebRTC can send UDP outside the proxy; only proxied traffic is allowed.
CHROMIUM_ARGS = ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp"]
