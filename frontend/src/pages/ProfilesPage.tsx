import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Cloud, ArrowUp } from 'lucide-react';
import { LocalProfilesView } from '../components/LocalProfilesView';

function ScrollToTop() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const toggleVisibility = () => {
      setIsVisible(window.scrollY > 300);
    };

    window.addEventListener('scroll', toggleVisibility);
    return () => window.removeEventListener('scroll', toggleVisibility);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (!isVisible) return null;

  return (
    <button
      onClick={scrollToTop}
      className="fixed bottom-6 right-6 p-3 bg-bambu-green hover:bg-bambu-green-light text-white rounded-full shadow-lg shadow-bambu-green/25 transition-all z-40"
      aria-label="Scroll to top"
    >
      <ArrowUp className="w-5 h-5" />
    </button>
  );
}

export function ProfilesPage() {
  const { t } = useTranslation();

  return (
    <div className="p-4 md:p-8">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <Cloud className="w-7 h-7 text-bambu-green" />
          {t('profiles.title')}
        </h1>
        <p className="text-bambu-gray mt-1">{t('profiles.subtitle')}</p>
      </div>

      {/* Local Profiles */}
      <LocalProfilesView />

      {/* Scroll to Top Button */}
      <ScrollToTop />
    </div>
  );
}
