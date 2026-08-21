import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings, ChevronDown, ChevronUp, Flame } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  PrintOptionsProps,
  PrintOptions as PrintOptionsType,
  PreheatOverride,
  CalibrationMode,
} from './types';
import {
  CALIBRATION_MODES,
  CALIBRATION_MODE_ACTIVE,
  CALIBRATION_MODE_INACTIVE,
} from '../../utils/calibrationMode';

type OptionConfig = {
  key: keyof PrintOptionsType;
  label: string;
  desc: string;
  dualNozzleOnly?: boolean;
  /** Tri-state (off/on/auto) rather than a plain on/off pair. */
  tristate?: boolean;
};

const HELP_TOOLTIP_GAP = 6;

/**
 * Compact-mode "?" chip; hover/focus shows the option description.
 * Portaled + fixed so Start-print panel overflow-hidden / overflow-y-auto
 * ancestors cannot clip the text (right-column "?" was the worst case).
 */
function OptionHelpIcon({ text, alignEnd = false }: { text: string; alignEnd?: boolean }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    transform: string;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setCoords(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    // Prefer above the trigger; end-align right-column chips to the "?" edge.
    setCoords({
      top: rect.top - HELP_TOOLTIP_GAP,
      left: alignEnd ? rect.right : rect.left + rect.width / 2,
      transform: alignEnd ? 'translate(-100%, -100%)' : 'translate(-50%, -100%)',
    });
  }, [open, alignEnd]);

  return (
    <span
      className="relative shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-bambu-gray/35 text-bambu-gray text-[9px] font-bold leading-none hover:bg-bambu-green hover:text-white transition-colors"
        aria-label={text}
        title={text}
      >
        ?
      </button>
      {open &&
        coords &&
        createPortal(
          <span
            role="tooltip"
            className="pointer-events-none fixed z-[200] w-max max-w-[14rem] px-2 py-1.5 rounded-md bg-bambu-dark-secondary border border-bambu-dark-tertiary text-[11px] leading-snug text-white shadow-lg whitespace-normal"
            style={{
              top: coords.top,
              left: coords.left,
              transform: coords.transform,
            }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}

// On/off options render as the same button pair, minus the "auto" choice.
const BOOLEAN_MODES = ['off', 'on'] as const;

function isCalibrationOn(value: CalibrationMode | boolean): boolean {
  return value === true || value === 'on' || value === 'auto';
}

/**
 * Print options toggle panel with collapsible UI.
 * Shows bed levelling, flow/vibration calibration, layer inspection,
 * and (for dual-nozzle printers only) nozzle offset calibration.
 *
 * `compact` (Start-print side panel): SimplyPrint-style 2×2 checkboxes for the
 * common toggles. Advanced holds only extras (nozzle offset if dual-nozzle,
 * Preheat & Heat Soak) — not a second copy of the four primary options.
 */
export function PrintOptionsPanel({
  options,
  onChange,
  defaultExpanded = false,
  showDualNozzleOptions = false,
  compact = false,
}: PrintOptionsProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded || compact);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Labels/descriptions reuse the settings.default* namespace — identical strings,
  // already translated across all locales. Only nozzle_offset_cali is new (#1682).
  const printOptionsConfig: OptionConfig[] = [
    { key: 'bed_levelling', label: t('settings.defaultBedLevelling'), desc: t('settings.defaultBedLevellingDesc'), tristate: true },
    { key: 'flow_cali', label: t('settings.defaultFlowCali'), desc: t('settings.defaultFlowCaliDesc'), tristate: true },
    { key: 'vibration_cali', label: t('settings.defaultVibrationCali'), desc: t('settings.defaultVibrationCaliDesc') },
    { key: 'layer_inspect', label: t('settings.defaultLayerInspect'), desc: t('settings.defaultLayerInspectDesc') },
    { key: 'nozzle_offset_cali', label: t('settings.defaultNozzleOffsetCali'), desc: t('settings.defaultNozzleOffsetCaliDesc'), dualNozzleOnly: true, tristate: true },
  ];

  const visibleOptions = printOptionsConfig.filter(o => !o.dualNozzleOnly || showDualNozzleOptions);
  const compactPrimary = visibleOptions.filter(
    (o) => o.key === 'bed_levelling' || o.key === 'flow_cali' || o.key === 'vibration_cali' || o.key === 'layer_inspect',
  );
  // Compact Advanced: extras only — never re-list the four primary checkboxes.
  const compactAdvancedOptions = visibleOptions.filter((o) => o.key === 'nozzle_offset_cali');
  // Preheat is always an Advanced extra; if both extras were ever removed, hide Advanced.
  const includeCompactPreheat = true;
  const hasCompactAdvanced = compactAdvancedOptions.length > 0 || includeCompactPreheat;

  const handleToggle = (key: keyof PrintOptionsType, value: boolean) => {
    onChange({ ...options, [key]: value });
  };

  const handleCalibrationMode = (key: keyof PrintOptionsType, mode: CalibrationMode) => {
    onChange({ ...options, [key]: mode });
  };

  /** Checkbox ON → auto (preferred default); OFF → off. */
  const handleCompactTriState = (key: 'bed_levelling' | 'flow_cali' | 'nozzle_offset_cali', checked: boolean) => {
    onChange({ ...options, [key]: checked ? 'auto' : 'off' });
  };

  const handlePreheatOverride = (next: PreheatOverride) => {
    onChange({
      ...options,
      preheat_override: next,
      // Clearing override→off also clears the chamber-target override so the
      // backend doesn't carry a stale value if the user re-enables later.
      ...(next === 'off' ? { preheat_chamber_target_override: null } : {}),
    });
  };

  const handlePreheatTarget = (raw: string) => {
    if (raw === '') {
      onChange({ ...options, preheat_chamber_target_override: null });
      return;
    }
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    onChange({
      ...options,
      preheat_chamber_target_override: Math.max(0, Math.min(60, parsed)),
    });
  };

  const renderOptionControl = ({ key, label, desc, tristate }: OptionConfig) =>
    tristate ? (
      <div key={key} className="flex items-center justify-between gap-3">
        <div>
          <span className="text-sm text-white">{label}</span>
          <p className="text-xs text-bambu-gray">{desc}</p>
        </div>
        <div className="flex gap-1 shrink-0">
          {CALIBRATION_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleCalibrationMode(key, mode)}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                options[key as 'bed_levelling'] === mode
                  ? CALIBRATION_MODE_ACTIVE[mode]
                  : CALIBRATION_MODE_INACTIVE
              }`}
            >
              {t(`settings.calibrationMode_${mode}`)}
            </button>
          ))}
        </div>
      </div>
    ) : (
      <div key={key} className="flex items-center justify-between gap-3">
        <div>
          <span className="text-sm text-white">{label}</span>
          <p className="text-xs text-bambu-gray">{desc}</p>
        </div>
        <div className="flex gap-1 shrink-0">
          {BOOLEAN_MODES.map((mode) => {
            const active = (options[key as 'vibration_cali'] ? 'on' : 'off') === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => handleToggle(key, mode === 'on')}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  active ? CALIBRATION_MODE_ACTIVE[mode] : CALIBRATION_MODE_INACTIVE
                }`}
              >
                {t(`settings.calibrationMode_${mode}`)}
              </button>
            );
          })}
        </div>
      </div>
    );

  // Preheat / heat-soak per-item override (#1468). Defaults to
  // 'inherit' which means the global Settings → Workflow toggle
  // decides. Forcing 'on' or 'off' overrides per-print; the chamber
  // target override (optional °C input, visible when not 'off')
  // bypasses the per-filament-type derivation.
  const renderPreheatControls = (withTopBorder: boolean) => (
    <div className={withTopBorder ? 'pt-2 mt-1 border-t border-bambu-dark-tertiary/60' : undefined}>
      <div className="flex items-center gap-2 mb-1.5">
        <Flame className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
        <span className="text-sm text-white">{t('settings.preheatTitle', 'Preheat & Heat Soak')}</span>
      </div>
      <p className="text-xs text-bambu-gray mb-2">
        {t('settings.preheatPerItemDesc', 'Heat the bed and chamber before this print starts. Defaults to the global Settings → Workflow toggle.')}
      </p>
      <div className="flex gap-1.5 mb-2">
        {(['inherit', 'on', 'off'] as PreheatOverride[]).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => handlePreheatOverride(opt)}
            className={`flex-1 px-2 py-1.5 text-xs rounded transition-colors ${
              options.preheat_override === opt
                ? 'bg-bambu-green text-white'
                : 'bg-bambu-dark-tertiary text-bambu-gray hover:text-white'
            }`}
          >
            {t(`settings.preheatOverride_${opt}`, opt === 'inherit' ? 'Inherit' : opt === 'on' ? 'On' : 'Off')}
          </button>
        ))}
      </div>
      {options.preheat_override !== 'off' && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-bambu-gray flex-1">
            {t('settings.preheatTargetOverride', 'Chamber target override (°C, blank = filament default)')}
          </label>
          <input
            type="number"
            min={0}
            max={60}
            step={1}
            value={options.preheat_chamber_target_override ?? ''}
            onChange={(e) => handlePreheatTarget(e.target.value)}
            placeholder="—"
            className="w-16 px-2 py-1 bg-bambu-dark-tertiary border border-bambu-dark-tertiary rounded text-white text-xs text-right focus:outline-none focus:border-bambu-green"
          />
        </div>
      )}
    </div>
  );

  const renderFullControls = () => (
    <>
      {visibleOptions.map(renderOptionControl)}
      {renderPreheatControls(true)}
    </>
  );

  const renderCompactAdvanced = () => (
    <>
      {compactAdvancedOptions.map(renderOptionControl)}
      {includeCompactPreheat && renderPreheatControls(compactAdvancedOptions.length > 0)}
    </>
  );

  if (compact) {
    return (
      <div data-testid="print-options-compact" className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-bambu-gray font-medium">
          {t('queue.bulkEdit.printOptions')}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          {compactPrimary.map(({ key, label, desc, tristate }, index) => {
            const checked = isCalibrationOn(options[key] as CalibrationMode | boolean);
            const id = `print-opt-compact-${key}`;
            return (
              <div
                key={key}
                className="flex items-center gap-2 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2.5 py-2 hover:border-bambu-green/40 transition-colors"
              >
                <label htmlFor={id} className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                  <input
                    id={id}
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      if (tristate) {
                        handleCompactTriState(key as 'bed_levelling' | 'flow_cali', e.target.checked);
                      } else {
                        handleToggle(key, e.target.checked);
                      }
                    }}
                    className="w-4 h-4 shrink-0 rounded border-bambu-gray bg-bambu-dark-secondary text-bambu-green focus:ring-bambu-green focus:ring-offset-0"
                  />
                  <span className="text-sm text-white leading-tight">{label}</span>
                </label>
                <OptionHelpIcon text={desc} alignEnd={index % 2 === 1} />
              </div>
            );
          })}
        </div>
        {hasCompactAdvanced && (
          <>
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              className="flex items-center gap-1.5 text-xs text-bambu-gray hover:text-white transition-colors w-full pt-1"
            >
              <Settings className="w-3.5 h-3.5" />
              <span>{t('printers.printOptionsAdvanced', 'Advanced options')}</span>
              {advancedOpen ? <ChevronUp className="w-3.5 h-3.5 ml-auto" /> : <ChevronDown className="w-3.5 h-3.5 ml-auto" />}
            </button>
            {advancedOpen && (
              <div className="bg-bambu-dark rounded-lg p-3 space-y-2 border border-bambu-dark-tertiary/80">
                {renderCompactAdvanced()}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-sm text-bambu-gray hover:text-white transition-colors w-full"
      >
        <Settings className="w-4 h-4" />
        <span>{t('queue.bulkEdit.printOptions')}</span>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 ml-auto" />
        ) : (
          <ChevronDown className="w-4 h-4 ml-auto" />
        )}
      </button>
      {isExpanded && (
        <div className="mt-2 bg-bambu-dark rounded-lg p-3 space-y-2">
          {renderFullControls()}
        </div>
      )}
    </div>
  );
}
