"""Change one setting of a running installation through the admin API (PUT /api/v1/admin/settings).

  python3 tools/admin/set_setting.py <category> <key> '<value as JSON>'

  python3 tools/admin/set_setting.py processing concurrency '{"now_llm":1,"night_llm":1}'
  python3 tools/admin/set_setting.py access test_sessions false

Where the request goes and which key it carries:
  MEMORY_BASE_URL        gateway address: http or https, a host, an optional port and path prefix; default
                         http://127.0.0.1:8080 (also when empty); surrounding whitespace is ignored; user info,
                         a query or a fragment is refused
  MEMORY_KEY_SYSTEM      the system key; when it is not set, the key is the "system_key" field of
  MEMORY_KEY_FILE        a JSON file; there is no default file

The gateway is always reached directly: proxy variables in the environment never get the key. Plain http is allowed
only for a gateway on this machine; any other gateway needs an https:// address. "On this machine" means the name
localhost or a name under .localhost (a trailing dot allowed), or a numeric address that the system reads as a
loopback or unspecified one: 127.0.0.0/8 in any notation the system accepts (127.1, 2130706433, 0x7f000001),
0.0.0.0, the IPv6 loopback and unspecified addresses, and the IPv4-mapped IPv6 form of a
loopback address. Other names are not looked up.

Prints the HTTP status code: exit 0 on 2xx, 1 on any other answer or when the gateway cannot be reached, 2 on bad
arguments, a bad address or no usable key. The key is never printed. Standard library only.
"""
import http.client
import ipaddress
import json
import os
import pathlib
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = "http://127.0.0.1:8080"
API_PATH = "/api/v1/admin/settings"


def fail(msg: str) -> None:
    print(f"set_setting: {msg}", file=sys.stderr)
    sys.exit(2)


def settings_url(env) -> str:
    return ((env.get("MEMORY_BASE_URL") or "").strip() or DEFAULT_URL).rstrip("/") + API_PATH


def header_safe(key: str) -> bool:
    """Printable ASCII without spaces: anything else cannot go into an Authorization header unchanged."""
    return all("!" <= ch <= "~" for ch in key)


def system_key() -> str:
    key = os.environ.get("MEMORY_KEY_SYSTEM", "")
    source = "MEMORY_KEY_SYSTEM"
    if not key:
        named = os.environ.get("MEMORY_KEY_FILE")
        if not named:
            fail("no system key: set MEMORY_KEY_SYSTEM or MEMORY_KEY_FILE (there is no default key file)")
        f = pathlib.Path(named)
        source = str(f)
        try:
            key = json.loads(f.read_text(encoding="utf-8-sig")).get("system_key", "")
        except (OSError, ValueError, AttributeError, RecursionError):
            key = ""
        if not isinstance(key, str) or not key:
            fail(f"no system key: set MEMORY_KEY_SYSTEM or MEMORY_KEY_FILE (a JSON file with \"system_key\"; tried {f})")
    if not header_safe(key):
        fail(f"the system key from {source} has whitespace, control or non-ASCII characters and cannot go into a "
             "request header (check for a trailing line break)")
    return key


def _this_machine(addr) -> bool:
    mapped = getattr(addr, "ipv4_mapped", None)
    if mapped is not None:
        addr = mapped
    return addr.is_loopback or addr.is_unspecified


def is_loopback(host: str) -> bool:
    name = (host or "").lower().rstrip(".")
    if name == "localhost" or name.endswith(".localhost"):
        return True
    try:
        # numeric forms only, read the way the connection will read them; names are never looked up
        infos = socket.getaddrinfo(host or "", None, flags=socket.AI_NUMERICHOST)
        addrs = {ipaddress.ip_address(info[4][0].split("%", 1)[0]) for info in infos}
    except (OSError, UnicodeError, ValueError):
        return False
    return bool(addrs) and all(_this_machine(a) for a in addrs)


def _shown(raw: str) -> str:
    """The address as given, with any user info masked."""
    head, sep, rest = raw.partition("//")
    netloc, slash, tail = rest.partition("/")
    if "@" in netloc:
        netloc = "***@" + netloc.rsplit("@", 1)[1]
    return head + sep + netloc + slash + tail


def check_address(url: str, raw: str):
    """The parts of the request address, or exit 2 with a message that names MEMORY_BASE_URL."""
    bad = f"MEMORY_BASE_URL must be an http:// or https:// address with a host, got {_shown(raw)!r}"
    if any(ch <= " " or ch == "\x7f" for ch in url):
        fail(f"{bad} (whitespace or control characters inside)")
    try:
        parts = urllib.parse.urlsplit(url)
        parts.port  # noqa: B018 - reading it validates the port
    except ValueError:
        fail(bad)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        fail(bad)
    if parts.username is not None or parts.password is not None or "?" in url or "#" in url:
        fail(f"{bad} (user info, a query or a fragment is not allowed)")
    if parts.scheme == "http" and not is_loopback(parts.hostname):
        fail("MEMORY_BASE_URL must be an https:// address when the gateway is not on this machine, "
             f"got {_shown(raw)!r}")
    return parts


def main(argv: list) -> int:
    if len(argv) != 3:
        fail("usage: set_setting.py <category> <key> '<value as JSON>'")
    category, key, raw = argv
    try:
        value = json.loads(raw)
    except ValueError:
        fail(f"the value is not JSON: {raw!r} (a string needs quotes: '\"text\"')")
    url = settings_url(os.environ)
    parts = check_address(url, os.environ.get("MEMORY_BASE_URL") or "")
    body = json.dumps({"items": [{"category": category, "key": key, "value": value}]}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PUT",
                                 headers={"Authorization": f"Bearer {system_key()}", "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=30) as r:
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
    except (urllib.error.URLError, OSError) as e:
        print(f"set_setting: {url} is not reachable: {getattr(e, 'reason', e)}", file=sys.stderr)
        return 1
    except http.client.HTTPException as e:
        print(f"set_setting: {url} did not answer with HTTP ({type(e).__name__})", file=sys.stderr)
        return 1
    except ValueError as e:
        # never str(e): the message of a refused header carries the header value
        print(f"set_setting: the request to {url} could not be sent ({type(e).__name__})", file=sys.stderr)
        return 1
    print(status)
    return 0 if 200 <= status < 300 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
