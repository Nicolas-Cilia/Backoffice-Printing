"""Unit tests for Docker self-update helpers."""

from unittest.mock import patch

from backend.app.services.docker_self_update import (
    docker_socket_path,
    resolve_update_image,
)


class TestResolveUpdateImage:
    def test_latest_tag_moves_to_target_version(self):
        # Pull the advertised release tag, not :latest (betas / pin drift).
        assert (
            resolve_update_image("ghcr.io/nicolas-cilia/backoffice-printing:latest", "1.2.0")
            == "ghcr.io/nicolas-cilia/backoffice-printing:1.2.0"
        )

    def test_daily_tag_moves_to_target_version(self):
        assert (
            resolve_update_image("ghcr.io/nicolas-cilia/backoffice-printing:daily", "1.2.0b1")
            == "ghcr.io/nicolas-cilia/backoffice-printing:1.2.0b1"
        )

    def test_pinned_version_moves_to_target(self):
        assert (
            resolve_update_image("ghcr.io/nicolas-cilia/backoffice-printing:1.1.0", "v1.2.0")
            == "ghcr.io/nicolas-cilia/backoffice-printing:1.2.0"
        )

    def test_missing_image_falls_back_to_ghcr(self):
        assert resolve_update_image("", "1.2.0") == "ghcr.io/nicolas-cilia/backoffice-printing:1.2.0"

    def test_digest_ref_uses_repo_plus_version(self):
        assert (
            resolve_update_image(
                "ghcr.io/nicolas-cilia/backoffice-printing@sha256:abc",
                "1.2.0",
            )
            == "ghcr.io/nicolas-cilia/backoffice-printing:1.2.0"
        )


class TestDockerSocketPath:
    def test_default_socket(self):
        with patch.dict("os.environ", {}, clear=True):
            assert str(docker_socket_path()) == "/var/run/docker.sock"

    def test_unix_docker_host(self):
        with patch.dict("os.environ", {"DOCKER_HOST": "unix:///custom/docker.sock"}, clear=False):
            assert str(docker_socket_path()) == "/custom/docker.sock"
