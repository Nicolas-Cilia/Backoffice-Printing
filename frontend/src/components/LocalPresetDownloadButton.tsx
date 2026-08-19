import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

export function LocalPresetDownloadButton({ presetId }: { presetId: number }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  if (!hasPermission('settings:read')) return null;

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.downloadLocalPreset(presetId);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t('profiles.localProfiles.toast.downloadFailed'),
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="p-1 text-bambu-gray hover:text-bambu-green transition-colors disabled:opacity-50"
      title={t('profiles.localProfiles.download')}
      aria-label={t('profiles.localProfiles.download')}
      data-testid="download-local-preset"
      disabled={busy}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
    </button>
  );
}
