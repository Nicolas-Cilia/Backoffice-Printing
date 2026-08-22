"""Unit tests for 2FA helper functions in mfa.py."""

import base64
import string
from datetime import datetime, timezone
from unittest.mock import patch

import pyotp
import pytest
from fastapi import HTTPException
from passlib.context import CryptContext

from backend.app.api.routes.mfa import (
    _assert_totp_not_replayed,
    _generate_backup_codes,
    _generate_totp_qr_b64,
)
from backend.app.models.user_totp import UserTOTP


class TestBackupCodeGeneration:
    """Tests for backup code helpers."""

    def test_generates_ten_codes(self):
        plain, hashed = _generate_backup_codes()
        assert len(plain) == 10
        assert len(hashed) == 10

    def test_codes_are_eight_chars(self):
        plain, _ = _generate_backup_codes()
        for code in plain:
            assert len(code) == 8

    def test_codes_are_alphanumeric(self):
        allowed = set(string.ascii_uppercase + string.digits)
        plain, _ = _generate_backup_codes()
        for code in plain:
            assert all(c in allowed for c in code)

    def test_hashes_verify_against_plain(self):
        ctx = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
        plain, hashed = _generate_backup_codes()
        for p, h in zip(plain, hashed, strict=True):
            assert ctx.verify(p, h)

    def test_codes_are_unique(self):
        plain, _ = _generate_backup_codes()
        assert len(set(plain)) == 10


class TestTOTPQRCode:
    """Tests for QR code generation helper."""

    def test_generates_base64_png(self):
        uri = "otpauth://totp/Bambuddy:testuser?secret=BASE32SECRET&issuer=Bambuddy"
        result = _generate_totp_qr_b64(uri)
        decoded = base64.b64decode(result)
        assert decoded[:4] == b"\x89PNG"


class TestAssertTotpNotReplayed:
    """Regression: identify the accepted code's counter via generate_otp, not TOTP.at.

    ``TOTP.at(n)`` treats ``n`` as a unix timestamp. Passing a time-step counter
    never matches, so the helper fell back to wall-clock ``timecode(now)``. After
    a 30s boundary, a still-valid previous-window code was stored as the *new*
    counter and replay succeeded (main CI: test_totp_replay_rejected_on_verify).
    """

    def test_stores_previous_window_counter_not_wall_clock(self):
        secret = pyotp.random_base32()
        totp = pyotp.TOTP(secret)
        # Freeze just after a step boundary so "now" is counter C, code is C-1.
        just_after = datetime(2026, 1, 1, 12, 0, 1, tzinfo=timezone.utc)
        prev_counter = totp.timecode(just_after) - 1
        code = totp.generate_otp(prev_counter)

        record = UserTOTP(user_id=1, secret=secret, is_enabled=True)
        record.last_totp_counter = None

        with patch("backend.app.api.routes.mfa.datetime") as mock_dt:
            mock_dt.now.return_value = just_after
            _assert_totp_not_replayed(totp, record, code)

        assert record.last_totp_counter == prev_counter
        assert record.last_totp_counter != totp.timecode(just_after)

    def test_replay_of_previous_window_code_rejected_after_boundary(self):
        secret = pyotp.random_base32()
        totp = pyotp.TOTP(secret)
        just_after = datetime(2026, 1, 1, 12, 0, 1, tzinfo=timezone.utc)
        prev_counter = totp.timecode(just_after) - 1
        code = totp.generate_otp(prev_counter)

        record = UserTOTP(user_id=1, secret=secret, is_enabled=True)
        record.last_totp_counter = None

        with patch("backend.app.api.routes.mfa.datetime") as mock_dt:
            mock_dt.now.return_value = just_after
            _assert_totp_not_replayed(totp, record, code)
            with pytest.raises(HTTPException) as exc:
                _assert_totp_not_replayed(totp, record, code)
        assert exc.value.status_code == 400
        assert "already used" in exc.value.detail
