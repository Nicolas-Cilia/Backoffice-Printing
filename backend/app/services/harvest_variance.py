"""Stats 2 (Phase 2) silent harvest-variance snapshot.

When a quantity is harvested (into a reusable bin, or at plate-close) we freeze
what the source production file said we *expected* to yield and the signed
difference. Measurement only — it never blocks or alters the harvest, and is
resolved best-effort.

``quantity_variance`` (and ``expected_quantity``) are left ``None`` when the
expectation is only the last-resort default (source ``"default"``), so a
fabricated "expected 1" never produces a misleading variance.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.expected_quantity import SOURCE_DEFAULT, resolve_expected_quantity


@dataclass(frozen=True)
class HarvestVarianceSnapshot:
    """Frozen expected-vs-actual snapshot for one harvest."""

    expected_quantity: int | None
    expected_quantity_source: str | None
    quantity_variance: int | None
    parsed_stem: str | None = None

    def as_event_details(self) -> dict:
        """Serialisable subset for a ``FloorBinBatchEvent.details`` JSON blob."""
        return {
            "expected_quantity": self.expected_quantity,
            "expected_quantity_source": self.expected_quantity_source,
            "quantity_variance": self.quantity_variance,
        }


async def snapshot_for_archive(
    db: AsyncSession,
    archive_id: int | None,
    actual_quantity: int | None,
) -> HarvestVarianceSnapshot:
    """Resolve the expected quantity for ``archive_id`` and compare to actual.

    A ``"default"`` expectation is treated as unknown → ``expected_quantity`` and
    ``quantity_variance`` are both ``None`` (source/stem still returned).
    """
    expected = await resolve_expected_quantity(db, archive_id)
    if expected.source == SOURCE_DEFAULT:
        return HarvestVarianceSnapshot(
            expected_quantity=None,
            expected_quantity_source=expected.source,
            quantity_variance=None,
            parsed_stem=expected.parsed_stem,
        )
    variance = None
    if actual_quantity is not None:
        variance = int(actual_quantity) - expected.quantity
    return HarvestVarianceSnapshot(
        expected_quantity=expected.quantity,
        expected_quantity_source=expected.source,
        quantity_variance=variance,
        parsed_stem=expected.parsed_stem,
    )


def apply_snapshot_to_batch(batch, snap: HarvestVarianceSnapshot) -> None:
    """Copy a snapshot onto a ``FloorBinBatch``'s variance columns."""
    batch.expected_quantity = snap.expected_quantity
    batch.expected_quantity_source = snap.expected_quantity_source
    batch.quantity_variance = snap.quantity_variance
