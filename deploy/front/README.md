# deploy/front — the TLS front on a server of its own

**Status of this page: a procedure verified in halves, not shown end to end between two servers.** The front was run
against a stand-in for the gateway, and the application host's settings and probe were run against a stand-in for the
front. `deploy/compose/setup` does not know this layout: it writes none of the values below and checks none of them.
You make the front's env file and folders by hand.

**One mistake on this path is not caught by the product.** If both settings of step 2 are missing on the application
host, the gateway treats everything the front passes as a caller from the internal network. Step 4 is the check for
it and must not be skipped: `404` — go on; `401` or any other answer — stop and close the front, as step 4 says.

**The hop from the front to the gateway is plain HTTP.** It may cross only a link that you control from end to end,
never the internet.

## What runs where

| | Application host | Front host |
|---|---|---|
| Runs | the whole install, profile `internal-http`, published on its address on the private link | only the service `proxy` of `deploy/front/compose.yaml` |
| Reached by | the front host alone, on the gateway port 8080 | the internet, on ports 80 and 443 |
| Holds | all data and all secrets of the memory | the TLS certificate and its private key, nothing of the memory |

The front passes only the routes of `deploy/compose/Caddyfile`. `deploy/front/compose.yaml` takes the proxy service of
`deploy/compose/compose.proxy.yaml` whole, so there is no second list of routes and no second set of container
limits. The panel and the workplace (port 8081) are never behind the front.

The front ends TLS: every request and every answer passes through it in the clear, the keys and tokens of agents
included. Whoever controls the front host can read them and can act as any agent that connects while they do. Protect
the front host like the application host.

The link between the two servers is a private network, or a routed tunnel of your own. It must deliver the front
host's own address as the source of its connections. A forward that ends in a program on the application host does
not: the gateway would see an address of that host or of a Docker bridge instead of the front's.

The examples use documentation addresses; yours are the addresses of your link.

| Example | Meaning |
|---|---|
| `198.51.100.10` | the application host's address on the private link |
| `198.51.100.20` | the front host's address on the private link |
| `203.0.113.5` | the front host's public address |
| `memory.example.com` | the public name; its DNS record points at the front host's public address |

## Never

- Never start the front before step 4 has printed `404`.
- Never send the hop from the front to the gateway over the internet.
- Never admit more than the one pair of step 3: not the workplace port 8081, not a network, not a second source.
- Never write a network, a second address or an address of a Docker bridge into `access.trusted_proxies`: one address
  with `/32`, the front host's own.
- Never add a port, a mount, a route, an image or a build line to `deploy/front/compose.yaml`, and never set
  `MEMORY_PROXY_ADDR` to `0.0.0.0`.
- Never give the front container the Docker socket or the host network.

## Steps

### 1. Application host: install for a closed network, published on the link address only

Prepare the host with `deploy/host/prepare-host.sh` as the install document says; its block `firewall` loads the
Docker guard. Without that guard both published ports are open to every machine that can reach the link address: do
not go on without it. Then install:

    deploy/compose/setup --profile internal-http --publish 198.51.100.10

Keep the gateway port at 8080 (do not set `GATEWAY_PORT`): the Caddyfile of the front reaches `gateway:8080`.
`sudo bash deploy/host/prepare-host.sh --check` must report both published ports as dropped by the guard. Until step 3
no other machine reaches either port.

### 2. Application host: name the front as the one trusted proxy

Copy `deploy/front/application-host.settings.json` to a file of your own outside the clone and replace the three
example values: the front host's address on the link with `/32`, the public name, the https address. Apply the copy
as the installing user, from the root of the clone (add `--dry-run` first to see what would be written):

    deploy/bin/memory-admin provision apply - < my-front.settings.json

It lists what it wrote and what it kept. Each of the three settings must be written or kept as `same_value`.
For any other kept setting, read the reason it prints and set that value before you go on.

- `access.trusted_proxies` makes the gateway take the front for a proxy: what arrives from that one address is a
  request from outside, and only the public routes answer it.
- `access.external_hosts` does the same by name: a request that carries the public name is a request from outside,
  whatever address it comes from.
- `access.cloud_agent_base_url` is the address the gateway writes into its answers to agents.

### 3. Application host: admit the front, and nothing else

    sudo bash deploy/host/prepare-host.sh --only firewall --admit 198.51.100.10:8080 --admit-from 198.51.100.20

A run replaces the list of the run before: if you already admit other pairs, name them in the same run. Read the
`WARN` lines of the run. A dropping rule of another firewall tool in the chain `DOCKER-USER` still applies after
`--admit`.

### 4. Front host: the probe — do not skip it

Before anything is started on the front host, run from it:

    curl -s -o /dev/null -m 8 -w '%{http_code}\n' http://198.51.100.10:8080/api/v1/health
    curl -s -o /dev/null -m 8 -w '%{http_code}\n' http://198.51.100.10:8080/api/v1/me

The first line shows that the link and the guard let this host through: it prints `200`, or `503` while the install
is not yet fully configured (a fresh install answers so). `000` means that nothing answered: check the link and the
`WARN` lines of step 3.

The second line is the check. It must print `404`: the gateway answers this host as a caller from outside and closes
everything but the public routes. `401`, or any other answer, means that the gateway treats this host as a machine of the
internal network — the trust of step 2 is missing, or it names another address than the one this host arrives from.
Then stop: do not start the front. On the application host close the way in again,

    sudo bash deploy/host/prepare-host.sh --only firewall

(naming with `--admit` only the pairs you admitted before this page), repair step 2 and repeat from step 3.

The mistake of the first paragraph needs the front host's link address to lie in a range the gateway counts as
internal: the private IPv4 ranges of RFC 1918 and the unique local IPv6 range, unless `access.internal_networks` says
otherwise. On a link with other addresses the second line prints `404` even without the trust of step 2. It then
shows that the front is answered as a caller from outside, not that step 2 is in place. Step 2 is required there
too. In the output of `provision apply`, confirm that each of the three settings was written or kept as `same_value`.

Run the second line again after every later change of the access settings on the application host.

### 5. Front host: the env file and the two folders

On the front host, in a clone of the same release as the application host, as a user that may use Docker. The
examples use `/srv/memory-front`, a folder that belongs to that user. Make the two folders Caddy writes to, for that
user only:

    mkdir -p /srv/memory-front/data/proxy /srv/memory-front/data/proxy-config
    chmod 700 /srv/memory-front/data/proxy /srv/memory-front/data/proxy-config

Write `/srv/memory-front/front.env`, mode 0600, with every line below and your values:

    MEMORY_UID=1000
    MEMORY_GID=1000
    MEMORY_VERSION=1.0.0
    MEMORY_HOME=/srv/memory-front
    MEMORY_PROXY_ADDR=203.0.113.5
    MEMORY_PUBLIC_DOMAIN=memory.example.com
    MEMORY_PROXY_TLS=internal
    MEMORY_FRONT_UPSTREAM=198.51.100.10
    MEMORY_FRONT_SUBNET=192.0.2.0/28
    MEMORY_FRONT_RANGE=192.0.2.8/29
    MEMORY_PROXY_IP=192.0.2.2
    MEMORY_PUBLIC_URL=https://memory.example.com
    MEMORY_TRUSTED_PROXIES=192.0.2.2/32

- `MEMORY_UID`, `MEMORY_GID`: what `id -u` and `id -g` print for that user, the owner of the two folders.
- `MEMORY_VERSION`: the version of the release, the value the application host has under the same name. Here it
  only names the image that is built.
- `MEMORY_PROXY_ADDR`: the one public IPv4 address ports 80 and 443 are published on.
- `MEMORY_PROXY_TLS`: `internal` makes Caddy sign with an authority of its own, which browsers and agents do not
  trust — good for a first test. For a public certificate put the e-mail address of your account at the certificate
  authority there instead; the first request needs ports 80 and 443 reachable from the internet under the public name.
- `MEMORY_FRONT_UPSTREAM`: the application host's address on the link, the one of steps 1 to 4.
- `MEMORY_FRONT_SUBNET`, `MEMORY_FRONT_RANGE`, `MEMORY_PROXY_IP`: a small subnet for the front's own Docker network
  that no network of the front host uses, its upper half, and the subnet's address plus 2.
- `MEMORY_PUBLIC_URL`, `MEMORY_TRUSTED_PROXIES`: the shared compose file reads them for the gateway, which does not
  run here. They must be present; nothing on the front uses them.

### 6. Front host: look at the configuration, then start

From the root of the clone:

    docker compose -p memory-front -f deploy/front/compose.yaml --env-file /srv/memory-front/front.env --profile proxy config
    docker compose -p memory-front -f deploy/front/compose.yaml --env-file /srv/memory-front/front.env --profile proxy up -d --build

The first command must show one service, `proxy`, without `depends_on`, both ports on the public address, and
`gateway` under `extra_hosts` with the application host's link address. The file was rendered with Docker Compose
5.7.0; a Compose client that does not know the `!reset` tag refuses it, and the first command shows that at once.
The second builds the image from the recipe `deploy/compose/images/proxy.Dockerfile` (it pulls the public Caddy base
image from Docker Hub, pinned by its digest) and starts it.

If the front host was prepared with `deploy/host/prepare-host.sh`, its Docker guard drops new connections to ports 80
and 443 until you admit them:

    sudo bash deploy/host/prepare-host.sh --only firewall --admit 203.0.113.5:80,203.0.113.5:443

### 7. From another machine: the public side

    curl -s -o /dev/null -m 8 -w '%{http_code}\n' https://memory.example.com/api/v1/health
    curl -s -o /dev/null -m 8 -w '%{http_code}\n' https://memory.example.com/api/v1/me
    curl -s -o /dev/null -m 8 -w '%{http_code}\n' https://memory.example.com/admin

With `MEMORY_PROXY_TLS=internal` add `-k`. Expected: `200`, `404`, `404`; the first is `503` while the install is not
yet fully configured.

## Stop

On the front host:

    docker compose -p memory-front -f deploy/front/compose.yaml --env-file /srv/memory-front/front.env --profile proxy down

On the application host close the way in: run step 3's command without the pair of the front (a run with no `--admit`
admits nothing).

## What this layout does not cover

- `deploy/compose/setup` neither writes nor checks it, on either host. A later run of `setup` does not look at the
  three settings of step 2.
- The trust is a stored setting. If an administrator empties `access.trusted_proxies` and `access.external_hosts`
  later, the mistake of the first paragraph is back; the second line of step 4 is the check.
- Which client address the gateway records behind the front, for its limits and for the audit log, was not measured
  for this layout. If it records the front's address, every limit that counts per address counts all callers together.
- Step 4 relies on `/api/v1/me` answering `401` to an internal caller without a key. If a later release changes that
  route, the probe proves nothing.
- The hop between the two servers is not encrypted by the product: the link is yours to protect.
- HTTP/3 (UDP 443) is not published.
- A separate network zone for the front with its own rules between the zones is later work.
- Not shown: the two halves joined between two servers.
