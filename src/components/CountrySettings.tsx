import React, { useState } from 'react';
import { CountryVocabulary, ExcludedCountry } from '../types';
import { Globe, Ban, Plus, Trash2, Save, CheckCircle2 } from 'lucide-react';

interface Props {
  vocabularies: CountryVocabulary[];
  excludedCountries: ExcludedCountry[];
  onSaveVocabulary: (vocab: CountryVocabulary) => Promise<void>;
  onAddExcluded: (country: ExcludedCountry) => Promise<void>;
  onRemoveExcluded: (countryName: string) => Promise<void>;
}

export const CountrySettings: React.FC<Props> = ({
  vocabularies,
  excludedCountries,
  onSaveVocabulary,
  onAddExcluded,
  onRemoveExcluded
}) => {
  const [selectedCountryName, setSelectedCountryName] = useState(vocabularies[0]?.country || 'United States');
  const [editingVocab, setEditingVocab] = useState<CountryVocabulary | null>(
    vocabularies.find(v => v.country === selectedCountryName) || vocabularies[0] || null
  );

  const [newTerm, setNewTerm] = useState('');
  const [newExclCountry, setNewExclCountry] = useState('');
  const [newExclReason, setNewExclReason] = useState('Regional Exclusion');

  const [saveSuccessMsg, setSaveSuccessMsg] = useState('');

  const handleCountrySelect = (countryName: string) => {
    setSelectedCountryName(countryName);
    const found = vocabularies.find(v => v.country === countryName);
    if (found) setEditingVocab({ ...found });
  };

  const handleAddTerm = () => {
    if (!newTerm.trim() || !editingVocab) return;
    setEditingVocab({
      ...editingVocab,
      native_trading_terminology: [...editingVocab.native_trading_terminology, newTerm.trim()]
    });
    setNewTerm('');
  };

  const handleRemoveTerm = (index: number) => {
    if (!editingVocab) return;
    const updated = [...editingVocab.native_trading_terminology];
    updated.splice(index, 1);
    setEditingVocab({ ...editingVocab, native_trading_terminology: updated });
  };

  const handleSaveVocabSubmit = async () => {
    if (!editingVocab) return;
    setSaveSuccessMsg('');
    await onSaveVocabulary(editingVocab);
    setSaveSuccessMsg(`Vocabulary updated for ${editingVocab.country}.`);
    setTimeout(() => setSaveSuccessMsg(''), 3000);
  };

  const handleAddExcludedSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newExclCountry.trim()) return;
    await onAddExcluded({ country_name: newExclCountry.trim(), reason: newExclReason });
    setNewExclCountry('');
  };

  return (
    <div className="space-y-6">
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* 1. ALLOWED COUNTRIES & NATIVE VOCABULARY ENGINE */}
        <div className="lg:col-span-2 p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Globe className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <h3 className="text-base font-bold text-slate-900 dark:text-white">Country Vocabulary & Terminology Engine</h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Manage native trading language terms per country to ensure searches mirror authentic local terminology.
              </p>
            </div>
          </div>

          {/* Country Selector */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            {vocabularies.map(v => (
              <button
                key={v.country}
                onClick={() => handleCountrySelect(v.country)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  selectedCountryName === v.country
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200'
                }`}
              >
                {v.country}
              </button>
            ))}
          </div>

          {editingVocab && (
            <div className="space-y-4 pt-2">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
                  Native Trading Terminology ({editingVocab.country}):
                </label>
                
                {/* Terms Pills */}
                <div className="flex flex-wrap gap-1.5 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 min-h-[80px]">
                  {editingVocab.native_trading_terminology.map((term, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-xs font-medium text-slate-800 dark:text-slate-200 shadow-2xs">
                      <span>{term}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveTerm(i)}
                        className="text-slate-400 hover:text-rose-600"
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                </div>

                {/* Add Term Input */}
                <div className="flex items-center gap-2 mt-2">
                  <input
                    type="text"
                    value={newTerm}
                    onChange={e => setNewTerm(e.target.value)}
                    placeholder="Add native term (e.g. Order flow, Liquidity sweep)..."
                    className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                  />
                  <button
                    type="button"
                    onClick={handleAddTerm}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 dark:bg-slate-700 dark:hover:bg-slate-600 text-white text-xs font-semibold rounded-lg flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="font-semibold text-slate-700 dark:text-slate-300 block mb-1">Popular Instruments</span>
                  <div className="p-2 bg-slate-50 dark:bg-slate-800/40 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400">
                    {editingVocab.popular_instruments.join(', ')}
                  </div>
                </div>

                <div>
                  <span className="font-semibold text-slate-700 dark:text-slate-300 block mb-1">Local Market Phrases</span>
                  <div className="p-2 bg-slate-50 dark:bg-slate-800/40 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400">
                    {editingVocab.local_market_phrases.join(', ')}
                  </div>
                </div>
              </div>

              {saveSuccessMsg && (
                <div className="p-2.5 rounded-lg bg-emerald-50 text-emerald-800 text-xs flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>{saveSuccessMsg}</span>
                </div>
              )}

              <button
                type="button"
                onClick={handleSaveVocabSubmit}
                className="py-2 px-4 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg shadow-xs flex items-center gap-2 transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Save Vocabulary Settings</span>
              </button>
            </div>
          )}
        </div>

        {/* 2. EXCLUDED COUNTRIES MANAGER */}
        <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs space-y-4">
          <div>
            <div className="flex items-center gap-2">
              <Ban className="w-5 h-5 text-rose-600 dark:text-rose-400" />
              <h3 className="text-base font-bold text-slate-900 dark:text-white">Excluded Countries</h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Channels from these regions are rejected during country validation and never stored.
            </p>
          </div>

          {/* Add Excluded Form */}
          <form onSubmit={handleAddExcludedSubmit} className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <input
              type="text"
              value={newExclCountry}
              onChange={e => setNewExclCountry(e.target.value)}
              placeholder="Country Name to Exclude..."
              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
              required
            />
            <input
              type="text"
              value={newExclReason}
              onChange={e => setNewExclReason(e.target.value)}
              placeholder="Exclusion Reason..."
              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
            />
            <button
              type="submit"
              className="w-full py-1.5 px-3 bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs rounded-lg flex items-center justify-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Country Exclusion</span>
            </button>
          </form>

          {/* Excluded List */}
          <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
            {excludedCountries.map(e => (
              <div key={e.country_name} className="p-2 bg-slate-50 dark:bg-slate-800/60 rounded border border-slate-200 dark:border-slate-700 flex items-center justify-between text-xs">
                <div>
                  <span className="font-semibold text-slate-800 dark:text-slate-200 block">{e.country_name}</span>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400">{e.reason}</span>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveExcluded(e.country_name)}
                  className="p-1 text-slate-400 hover:text-rose-600"
                  title="Remove exclusion"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

      </div>

    </div>
  );
};
