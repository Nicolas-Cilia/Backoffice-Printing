/**
 * Floor landing page — `/floor` (docs/floor-plan.md §3.1/§15).
 *
 * The sidebar "Floor" item's destination: a picker between the two real
 * Floor pages. Not a kiosk bookmark — floor-bench PCs bookmark the explicit
 * `/floor/scan` URL directly so they never see a picker on reload (§2.1).
 * This page exists so someone navigating normally has any way to *reach*
 * `/floor/codes` at all — before it existed nothing in the app linked there.
 *
 * Codes (label printing, SKU registration) isn't built yet — the button
 * stays disabled until that phase ships, rather than linking to a route
 * that doesn't exist.
 */
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ScanLine, QrCode } from 'lucide-react';
import { Button } from '../components/Button';

export function FloorLandingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-bambu-gray">
          {t('floor.landingEyebrow', 'Production floor')}
        </p>
        <h1 className="text-2xl font-bold text-white mt-1">{t('floor.landingTitle', 'Floor')}</h1>
        <p className="text-bambu-gray mt-1 max-w-2xl">
          {t(
            'floor.landingSubtitle',
            'Scan is the pistol-input station for the floor. Codes prints the QR labels that make scanning work.',
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
        <article className="bg-bambu-dark-secondary rounded-lg p-6 flex flex-col">
          <ScanLine className="w-8 h-8 text-bambu-green mb-3" aria-hidden="true" />
          <h2 className="text-white font-semibold text-lg">{t('floor.landingScanTitle', 'Scan')}</h2>
          <p className="text-sm text-bambu-gray mt-1 flex-1">
            {t(
              'floor.landingScanDescription',
              'Pistol-input station for the printer line, cleanup bench, WIP shelf, and warehouse.',
            )}
          </p>
          <Button className="mt-4 self-start" onClick={() => navigate('/floor/scan')}>
            {t('floor.landingScanAction', 'Open Scan')}
          </Button>
        </article>

        <article className="bg-bambu-dark-secondary rounded-lg p-6 flex flex-col">
          <QrCode className="w-8 h-8 text-bambu-gray mb-3" aria-hidden="true" />
          <div className="flex items-center gap-2">
            <h2 className="text-white font-semibold text-lg">{t('floor.landingCodesTitle', 'Codes')}</h2>
            <span className="text-[11px] uppercase tracking-wide text-bambu-gray bg-bambu-dark-tertiary rounded px-1.5 py-0.5">
              {t('floor.landingComingSoon', 'Coming soon')}
            </span>
          </div>
          <p className="text-sm text-bambu-gray mt-1 flex-1">
            {t(
              'floor.landingCodesDescription',
              'Print station, printer, and error QR labels, and register filament SKUs.',
            )}
          </p>
          <Button className="mt-4 self-start" variant="secondary" disabled>
            {t('floor.landingCodesAction', 'Open Codes')}
          </Button>
        </article>
      </div>
    </div>
  );
}

export default FloorLandingPage;
