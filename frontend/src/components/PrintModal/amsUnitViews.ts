import type { AMSTray, PrinterStatus } from '../../api/client';
import type { LoadedFilament } from '../../hooks/useFilamentMapping';
import { getAmsLabel } from '../../utils/amsHelpers';

export type AmsUnitView = {
  key: string;
  amsId: number;
  label: string;
  isExternal: boolean;
  isHt: boolean;
  trays: Array<{
    trayId: number;
    slotNumber: number | string;
    tray: AMSTray | null;
    loaded: LoadedFilament | undefined;
  }>;
};

export function buildAmsUnitViews(
  printerStatus: PrinterStatus,
  loadedFilaments: LoadedFilament[],
): AmsUnitView[] {
  const units: AmsUnitView[] = [];

  for (const amsUnit of printerStatus.ams ?? []) {
    const isHt = amsUnit.is_ams_ht || amsUnit.tray.length === 1;
    const slotCount = isHt ? 1 : Math.max(4, amsUnit.tray.length);
    const trays = Array.from({ length: slotCount }, (_, i) => {
      const tray = amsUnit.tray.find((t) => t.id === i) ?? null;
      const loaded = loadedFilaments.find(
        (f) => !f.isExternal && f.amsId === amsUnit.id && f.trayId === i,
      );
      return {
        trayId: i,
        slotNumber: i + 1,
        tray,
        loaded,
      };
    });
    units.push({
      key: `ams-${amsUnit.id}`,
      amsId: amsUnit.id,
      label: getAmsLabel(amsUnit.id, slotCount),
      isExternal: false,
      isHt,
      trays,
    });
  }

  const vtTrays = [...(printerStatus.vt_tray ?? [])].sort((a, b) => (a.id ?? 254) - (b.id ?? 254));
  if (vtTrays.length > 0) {
    const hasDualExternal = vtTrays.length > 1;
    units.push({
      key: 'external',
      amsId: 255,
      label: getAmsLabel(255, vtTrays.length),
      isExternal: true,
      isHt: false,
      trays: vtTrays.map((tray) => {
        const trayId = tray.id ?? 254;
        const loaded = loadedFilaments.find((f) => f.isExternal && f.globalTrayId === trayId);
        return {
          trayId: trayId - 254,
          slotNumber: hasDualExternal ? (trayId === 254 ? 'L' : 'R') : 1,
          tray,
          loaded,
        };
      }),
    });
  }

  return units;
}
