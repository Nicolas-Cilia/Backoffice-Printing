"""In-app Docker image update via the host Docker engine socket.

When ``/var/run/docker.sock`` is mounted into the Bambuddy container and the
app user can talk to the engine, Settings → Install Update can:

1. Pull the published GHCR image for the target release tag (or the current
   moving tag such as ``:latest`` / ``:daily``).
2. Hand off stop/recreate/start to a short-lived helper container so this
   process is not mid-flight when it is replaced.

Without the socket (the default compose template), the updates API keeps
returning host-side ``docker compose pull && up`` instructions.

Security: mounting the Docker socket is equivalent to root on the host.
Operators must opt in via compose; see ``docs/docker-workflow.md``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DOCKER_SOCK = Path("/var/run/docker.sock")
GHCR_IMAGE = "ghcr.io/nicolas-cilia/backoffice-printing"
_HELPER_NAME = "bambuddy-updater"
_ProgressCb = Callable[[int, str], Awaitable[None] | None]

# HostConfig keys that Inspect returns but Create rejects or that are unsafe
# to echo back verbatim.
_HOST_CONFIG_DROP = frozenset(
    {
        "ConsoleSize",
        "Mask",
        "Status",
    }
)

# Container Config keys present on Inspect that are not valid on Create.
_CONFIG_DROP = frozenset(
    {
        "Args",
        "AttachStderr",
        "AttachStdin",
        "AttachStdout",
        "CreateCommand",
        "Shell",
        "OnBuild",
    }
)


class DockerSelfUpdateError(RuntimeError):
    """Raised when a Docker Engine step fails during self-update."""


def docker_socket_path() -> Path:
    host = os.environ.get("DOCKER_HOST", "").strip()
    if host.startswith("unix://"):
        return Path(host[len("unix://") :])
    if host.startswith("unix:"):
        return Path(host[len("unix:") :])
    if host:
        # Non-unix DOCKER_HOST values are not supported for in-app updates.
        return DOCKER_SOCK
    return DOCKER_SOCK


def is_docker_socket_available() -> bool:
    """True when the engine socket exists and answers ``/_ping``.

    Used by ``/updates/check`` so the UI can offer Install Update vs. manual
    compose instructions. Synchronous on purpose (cheap local I/O + tiny HTTP).
    """
    sock = docker_socket_path()
    if not sock.is_socket() and not sock.exists():
        return False
    try:
        with httpx.Client(
            transport=httpx.HTTPTransport(uds=str(sock)),
            base_url="http://docker",
            timeout=2.0,
        ) as client:
            response = client.get("/_ping")
            return response.status_code == 200 and response.text.strip() == "OK"
    except (httpx.HTTPError, OSError, ValueError):
        return False


def resolve_update_image(current_image: str, target_version: str) -> str:
    """Pick the image reference to pull and run after an in-app update.

    Always pull the discovered release version on the same repository so
    Settings "Install Update" matches the advertised tag (including betas).
    Moving tags like ``:latest`` / ``:daily`` are not re-pulled as-is — that
    would ignore the version check just surfaced in the UI.

    Unknown / digest refs fall back to our published GHCR image + version.
    """
    version = target_version.lstrip("v").strip()
    if not version:
        raise DockerSelfUpdateError("Missing target version for Docker update")

    image = (current_image or "").strip()
    if not image or image.startswith("sha256:"):
        return f"{GHCR_IMAGE}:{version}"

    if "@" in image:
        repo = image.split("@", 1)[0]
        return f"{repo}:{version}"

    if ":" in image:
        repo, _tag = image.rsplit(":", 1)
        return f"{repo}:{version}"

    return f"{image}:{version}"


def _read_self_container_id() -> str | None:
    """Best-effort container ID for the process we are running in."""
    # cgroup v1: .../docker/<64-hex>
    try:
        text = Path("/proc/self/cgroup").read_text(encoding="utf-8")
    except OSError:
        text = ""
    match = re.search(r"[0-9a-f]{64}", text)
    if match:
        return match.group(0)

    # cgroup v2 / mountinfo: .../docker/containers/<id>/...
    try:
        mountinfo = Path("/proc/self/mountinfo").read_text(encoding="utf-8")
    except OSError:
        mountinfo = ""
    match = re.search(r"/docker/containers/([0-9a-f]{12,64})/", mountinfo)
    if match:
        return match.group(1)

    # Docker sets hostname to the short container id by default.
    host = os.environ.get("HOSTNAME", "").strip()
    if re.fullmatch(r"[0-9a-f]{12,64}", host):
        return host
    return None


class DockerEngine:
    """Minimal async Docker Engine client over a unix socket."""

    def __init__(self, sock: Path | None = None):
        self.sock = sock or docker_socket_path()

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.AsyncHTTPTransport(uds=str(self.sock)),
            base_url="http://docker",
            timeout=httpx.Timeout(600.0, connect=5.0),
        )

    async def ping(self) -> bool:
        try:
            async with self._client() as client:
                response = await client.get("/_ping")
                return response.status_code == 200 and response.text.strip() == "OK"
        except (httpx.HTTPError, OSError, ValueError):
            return False

    async def inspect_container(self, container_id: str) -> dict[str, Any]:
        async with self._client() as client:
            response = await client.get(f"/containers/{container_id}/json")
            if response.status_code == 404:
                raise DockerSelfUpdateError(f"Container not found: {container_id}")
            response.raise_for_status()
            return response.json()

    async def pull_image(self, image: str, on_progress: _ProgressCb | None = None) -> None:
        if ":" in image and "@" not in image:
            from_image, tag = image.rsplit(":", 1)
        else:
            from_image, tag = image, "latest"

        async with (
            self._client() as client,
            client.stream(
                "POST",
                "/images/create",
                params={"fromImage": from_image, "tag": tag},
            ) as response,
        ):
            if response.status_code >= 400:
                body = (await response.aread()).decode("utf-8", errors="replace")
                raise DockerSelfUpdateError(f"Image pull failed ({response.status_code}): {body[:500]}")

            last_status = ""
            async for line in response.aiter_lines():
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if err := event.get("error"):
                    raise DockerSelfUpdateError(f"Image pull failed: {err}")
                status = event.get("status") or ""
                if status and status != last_status and on_progress:
                    last_status = status
                    maybe = on_progress(55, f"Pulling image: {status}")
                    if asyncio.iscoroutine(maybe):
                        await maybe

    async def create_container(self, body: dict[str, Any], name: str | None = None) -> str:
        params = {"name": name} if name else None
        async with self._client() as client:
            response = await client.post("/containers/create", params=params, json=body)
            if response.status_code >= 400:
                raise DockerSelfUpdateError(f"Create container failed ({response.status_code}): {response.text[:500]}")
            data = response.json()
            container_id = data.get("Id")
            if not isinstance(container_id, str) or not container_id:
                raise DockerSelfUpdateError("Create container returned no Id")
            return container_id

    async def start_container(self, container_id: str) -> None:
        async with self._client() as client:
            response = await client.post(f"/containers/{container_id}/start")
            if response.status_code not in (204, 304):
                raise DockerSelfUpdateError(f"Start container failed ({response.status_code}): {response.text[:500]}")

    async def stop_container(self, container_id: str, timeout: int = 30) -> None:
        async with self._client() as client:
            response = await client.post(
                f"/containers/{container_id}/stop",
                params={"t": timeout},
            )
            if response.status_code not in (204, 304, 404):
                raise DockerSelfUpdateError(f"Stop container failed ({response.status_code}): {response.text[:500]}")

    async def rename_container(self, container_id: str, new_name: str) -> None:
        async with self._client() as client:
            response = await client.post(
                f"/containers/{container_id}/rename",
                params={"name": new_name},
            )
            if response.status_code >= 400:
                raise DockerSelfUpdateError(f"Rename container failed ({response.status_code}): {response.text[:500]}")

    async def remove_container(self, container_id: str, *, force: bool = False) -> None:
        async with self._client() as client:
            response = await client.delete(
                f"/containers/{container_id}",
                params={"force": "true" if force else "false"},
            )
            if response.status_code not in (204, 404):
                raise DockerSelfUpdateError(f"Remove container failed ({response.status_code}): {response.text[:500]}")

    async def connect_network(
        self,
        network_id: str,
        container_id: str,
        endpoint_config: dict[str, Any] | None = None,
    ) -> None:
        body: dict[str, Any] = {"Container": container_id}
        if endpoint_config:
            body["EndpointConfig"] = endpoint_config
        async with self._client() as client:
            response = await client.post(f"/networks/{network_id}/connect", json=body)
            if response.status_code not in (200, 204):
                # Already connected is fine during recreate edge cases.
                if response.status_code == 403 and "already" in response.text.lower():
                    return
                raise DockerSelfUpdateError(f"Network connect failed ({response.status_code}): {response.text[:500]}")


def _create_body_from_inspect(info: dict[str, Any], new_image: str) -> dict[str, Any]:
    """Build a ContainerCreate body that preserves runtime overrides."""
    config = dict(info.get("Config") or {})
    for key in _CONFIG_DROP:
        config.pop(key, None)
    host_config = dict(info.get("HostConfig") or {})
    for key in _HOST_CONFIG_DROP:
        host_config.pop(key, None)

    config["Image"] = new_image
    # Inspect merges image defaults; clearing hostname under container
    # network mode avoids clashes on recreate (watchtower pattern).
    network_mode = str(host_config.get("NetworkMode") or "")
    if network_mode.startswith("container:"):
        config["Hostname"] = ""

    networks = (info.get("NetworkSettings") or {}).get("Networks") or {}
    networking: dict[str, Any] = {"EndpointsConfig": {}}
    primary_network = None
    for net_name, endpoint in networks.items():
        if not isinstance(endpoint, dict):
            continue
        if primary_network is None:
            primary_network = net_name
        # Omit live endpoint identity (EndpointID / IP / MAC) so Docker
        # assigns fresh addresses on create — copying them breaks recreate.
        networking["EndpointsConfig"][net_name] = {
            "IPAMConfig": endpoint.get("IPAMConfig"),
            "Links": endpoint.get("Links"),
            "Aliases": endpoint.get("Aliases"),
            "NetworkID": endpoint.get("NetworkID"),
        }

    # When not using host/container network mode, create attaches to one
    # network then we reconnect the rest after start.
    if primary_network and network_mode not in ("host", "none") and not network_mode.startswith("container:"):
        host_config["NetworkMode"] = primary_network

    return {
        "Config": config,
        "HostConfig": host_config,
        "NetworkingConfig": networking,
        "primary_network": primary_network,
        "all_networks": networking["EndpointsConfig"],
    }


async def recreate_container(engine: DockerEngine, container_id: str, new_image: str) -> None:
    """Stop → rename → create → start → remove old (Watchtower-style handoff).

    Stopping first frees published host ports so the replacement can bind
    the same ``HostConfig.PortBindings`` (default compose publishes 8484:8000).
    """
    info = await engine.inspect_container(container_id)
    name = str(info.get("Name") or "").lstrip("/") or "bambuddy"
    old_name = f"{name}-preupdate"

    built = _create_body_from_inspect(info, new_image)
    config = built["Config"]
    host_config = built["HostConfig"]
    networking = {"EndpointsConfig": {}}
    primary = built["primary_network"]
    all_networks = built["all_networks"]
    if primary and primary in all_networks:
        networking["EndpointsConfig"] = {primary: all_networks[primary]}

    # Drop any leftover helper / preupdate from a prior failed attempt.
    try:
        await engine.remove_container(old_name, force=True)
    except DockerSelfUpdateError:
        pass

    # Free host ports / network binds before the replacement starts.
    await engine.stop_container(container_id)
    await engine.rename_container(container_id, old_name)

    create_payload = {
        **config,
        "HostConfig": host_config,
        "NetworkingConfig": networking,
    }
    try:
        new_id = await engine.create_container(create_payload, name=name)
    except Exception:
        # Best-effort rollback of the rename so the old container keeps its name.
        try:
            await engine.rename_container(old_name, name)
            await engine.start_container(old_name)
        except DockerSelfUpdateError:
            logger.exception("Failed to roll back container rename after create error")
        raise

    try:
        await engine.start_container(new_id)
        for net_name, endpoint in all_networks.items():
            if net_name == primary:
                continue
            network_id = endpoint.get("NetworkID") or net_name
            await engine.connect_network(network_id, new_id, endpoint)
    except Exception:
        logger.exception("Failed to start recreated container; attempting rollback")
        try:
            await engine.remove_container(new_id, force=True)
        except DockerSelfUpdateError:
            pass
        try:
            await engine.rename_container(old_name, name)
            await engine.start_container(old_name)
        except DockerSelfUpdateError:
            logger.exception("Rollback of previous container failed")
        raise

    try:
        await engine.remove_container(old_name, force=True)
    except DockerSelfUpdateError as exc:
        logger.warning("New container started but old container cleanup failed: %s", exc)


async def launch_recreate_helper(
    engine: DockerEngine,
    *,
    self_id: str,
    self_image: str,
    new_image: str,
) -> None:
    """Start a one-shot helper that recreates ``self_id`` after a short delay."""
    try:
        await engine.remove_container(_HELPER_NAME, force=True)
    except DockerSelfUpdateError:
        pass

    # Override entrypoint so we do not re-run docker-entrypoint.sh / gosu.
    body = {
        "Image": self_image,
        "Entrypoint": ["python", "-m", "backend.app.services.docker_self_update"],
        "Cmd": ["recreate", self_id, new_image],
        "HostConfig": {
            "Binds": [f"{docker_socket_path()}:/var/run/docker.sock"],
            "AutoRemove": True,
            "NetworkMode": "bridge",
        },
        "Env": [
            "PYTHONUNBUFFERED=1",
            "DOCKER_HOST=unix:///var/run/docker.sock",
        ],
        "Labels": {
            "bambuddy.updater": "1",
        },
        "User": "0:0",
    }
    helper_id = await engine.create_container(body, name=_HELPER_NAME)
    await engine.start_container(helper_id)
    logger.info(
        "Started Docker self-update helper %s to recreate %s onto %s",
        helper_id[:12],
        self_id[:12],
        new_image,
    )


async def perform_docker_self_update(
    target_version: str,
    *,
    on_progress: _ProgressCb | None = None,
) -> None:
    """Pull the target image and hand off container recreate to a helper."""

    async def progress(pct: int, message: str) -> None:
        if on_progress:
            maybe = on_progress(pct, message)
            if asyncio.iscoroutine(maybe):
                await maybe

    engine = DockerEngine()
    if not await engine.ping():
        raise DockerSelfUpdateError(
            "Docker socket is not reachable. Mount /var/run/docker.sock and "
            "ensure the container user can access it (see docs/docker-workflow.md)."
        )

    self_id = _read_self_container_id()
    if not self_id:
        raise DockerSelfUpdateError("Could not determine this container's ID")

    await progress(20, "Inspecting running container...")
    info = await engine.inspect_container(self_id)
    current_image = str((info.get("Config") or {}).get("Image") or "")
    new_image = resolve_update_image(current_image, target_version)

    await progress(35, f"Pulling {new_image}...")
    await engine.pull_image(new_image, on_progress=on_progress)

    # Helper must run from an image that already has this module. Prefer the
    # image we are currently running (always present locally).
    self_image_id = str(info.get("Image") or current_image)
    await progress(85, "Starting update helper (container will restart)...")
    await launch_recreate_helper(
        engine,
        self_id=self_id,
        self_image=self_image_id if self_image_id.startswith("sha256:") else current_image or self_image_id,
        new_image=new_image,
    )
    await progress(95, "Restarting with new image...")


async def _helper_main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[0] != "recreate":
        print(
            "usage: python -m backend.app.services.docker_self_update recreate <container_id> <image>", file=sys.stderr
        )
        return 2
    container_id, new_image = argv[1], argv[2]
    # Give the parent API a moment to finish the HTTP response / status write.
    await asyncio.sleep(2)
    engine = DockerEngine()
    await recreate_container(engine, container_id, new_image)
    return 0


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    raise SystemExit(asyncio.run(_helper_main(args)))


if __name__ == "__main__":
    main()
