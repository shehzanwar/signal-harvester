import { useEffect, useState } from "react";
import { getWeights, importWeights, resetWeights, topWeights, type WeightRow } from "../lib/affinity";
import { orderedCategories } from "../lib/categories";
import type { Interest, Prefs } from "../lib/prefs";

interface Props {
  open: boolean;
  onClose: () => void;
  prefs: Prefs;
  onUpdate: (updater: (p: Prefs) => Prefs) => void;
  onReplacePrefs: (p: Prefs) => void;
}

const INTERESTS: Interest[] = ["low", "normal", "high"];
const INTEREST_LABEL: Record<Interest, string> = { low: "Less", normal: "Normal", high: "More" };

export function PrefsPanel({ open, onClose, prefs, onUpdate, onReplacePrefs }: Props) {
  const [tagInput, setTagInput] = useState("");
  const [kwInput, setKwInput] = useState("");
  const [learned, setLearned] = useState<{ liked: WeightRow[]; disliked: WeightRow[] }>({
    liked: [],
    disliked: [],
  });
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState("");

  // Refresh the learned-weights view when the panel opens or the model changes.
  useEffect(() => {
    if (!open) return;
    const refresh = () => setLearned(topWeights());
    refresh();
    window.addEventListener("affinity-change", refresh);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("affinity-change", refresh);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const cats = orderedCategories(prefs.categoryOrder);

  const addTag = () => {
    const t = tagInput.trim().toLowerCase();
    if (t && !prefs.mutedTags.includes(t)) onUpdate((p) => ({ ...p, mutedTags: [...p.mutedTags, t] }));
    setTagInput("");
  };
  const addKeyword = () => {
    const k = kwInput.trim();
    if (k && !prefs.mutedKeywords.includes(k)) onUpdate((p) => ({ ...p, mutedKeywords: [...p.mutedKeywords, k] }));
    setKwInput("");
  };
  const removeTag = (t: string) => onUpdate((p) => ({ ...p, mutedTags: p.mutedTags.filter((x) => x !== t) }));
  const removeKw = (k: string) => onUpdate((p) => ({ ...p, mutedKeywords: p.mutedKeywords.filter((x) => x !== k) }));
  const setInterest = (cat: string, v: Interest) =>
    onUpdate((p) => ({ ...p, categoryInterest: { ...p.categoryInterest, [cat]: v } }));

  const moveCat = (key: string, dir: -1 | 1) =>
    onUpdate((p) => {
      const order = [...p.categoryOrder];
      const i = order.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return p;
      [order[i], order[j]] = [order[j], order[i]];
      return { ...p, categoryOrder: order };
    });

  const exportJson = () =>
    JSON.stringify({ version: 1, prefs, weights: getWeights() }, null, 2);

  const doImport = () => {
    try {
      const parsed = JSON.parse(importText);
      if (parsed.prefs) onReplacePrefs(parsed.prefs as Prefs);
      if (parsed.weights) importWeights(parsed.weights as Record<string, number>);
      setImportMsg("Imported ✓");
      setImportText("");
    } catch {
      setImportMsg("Invalid JSON");
    }
  };

  const copyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportJson());
      setImportMsg("Copied backup to clipboard ✓");
    } catch {
      setImportMsg("Copy failed — select the text manually");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex sm:items-center sm:justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div
        className="relative bg-neutral-900 border border-neutral-700 w-full h-full sm:h-auto sm:max-h-[85vh]
                   sm:max-w-lg sm:rounded-2xl overflow-y-auto shadow-2xl flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-neutral-800 sticky top-0 bg-neutral-900 z-10">
          <h2 className="text-base font-semibold text-white">Preferences</h2>
          <button
            onClick={onClose}
            aria-label="Close preferences"
            className="flex items-center justify-center h-9 w-9 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>

        <div className="p-4 flex flex-col gap-6 text-sm">
          {/* Muted tags */}
          <Section title="Muted tags" hint="Hide cards with these tags">
            <ChipRow items={prefs.mutedTags} onRemove={removeTag} empty="No muted tags" />
            <AddRow
              value={tagInput}
              onChange={setTagInput}
              onAdd={addTag}
              placeholder="e.g. golf"
            />
          </Section>

          {/* Muted keywords */}
          <Section title="Muted keywords" hint="Hide cards whose title/summary contains these">
            <ChipRow items={prefs.mutedKeywords} onRemove={removeKw} empty="No muted keywords" />
            <AddRow
              value={kwInput}
              onChange={setKwInput}
              onAdd={addKeyword}
              placeholder="e.g. royals"
            />
          </Section>

          {/* Category interest + order */}
          <Section title="Categories" hint="Interest tunes the For You order; arrows reorder the bar">
            <div className="flex flex-col gap-2">
              {cats.map((c, idx) => {
                const cur = prefs.categoryInterest[c.key] ?? "normal";
                return (
                  <div key={c.key} className="flex items-center gap-2">
                    <div className="flex flex-col">
                      <button
                        onClick={() => moveCat(c.key, -1)}
                        disabled={idx === 0}
                        aria-label={`Move ${c.label} up`}
                        className="text-neutral-500 hover:text-neutral-200 disabled:opacity-20 leading-none text-[10px]"
                      >
                        ▲
                      </button>
                      <button
                        onClick={() => moveCat(c.key, 1)}
                        disabled={idx === cats.length - 1}
                        aria-label={`Move ${c.label} down`}
                        className="text-neutral-500 hover:text-neutral-200 disabled:opacity-20 leading-none text-[10px]"
                      >
                        ▼
                      </button>
                    </div>
                    <span className="w-20 text-neutral-300">{c.label}</span>
                    <div className="flex gap-1 ml-auto">
                      {INTERESTS.map((v) => (
                        <button
                          key={v}
                          onClick={() => setInterest(c.key, v)}
                          className={`px-2 py-1 rounded text-xs border transition-colors ${
                            cur === v
                              ? "bg-blue-900/40 border-blue-600 text-blue-200"
                              : "border-neutral-700 text-neutral-500 hover:border-neutral-500"
                          }`}
                        >
                          {INTEREST_LABEL[v]}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* Learned weights (transparency) */}
          <Section title="What you've been tapping" hint="Learned from your opens, saves & mutes — decays over ~2 weeks">
            {learned.liked.length === 0 && learned.disliked.length === 0 ? (
              <p className="text-neutral-600 text-xs">No signal yet. Open and save a few stories.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {learned.liked.map((r) => (
                  <WeightBar key={r.feature} label={r.label} weight={r.weight} />
                ))}
                {learned.disliked.map((r) => (
                  <WeightBar key={r.feature} label={r.label} weight={r.weight} />
                ))}
              </div>
            )}
            <button
              onClick={resetWeights}
              className="mt-3 text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:border-red-700 hover:text-red-400"
            >
              Reset learning
            </button>
          </Section>

          {/* Backup / restore */}
          <Section title="Backup / restore" hint="Move your prefs & learning between phone and desktop">
            <div className="flex gap-2 mb-2">
              <button
                onClick={copyExport}
                className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500"
              >
                Copy backup
              </button>
              <button
                onClick={doImport}
                disabled={!importText.trim()}
                className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
              >
                Import pasted
              </button>
              {importMsg && <span className="text-xs text-neutral-500 self-center">{importMsg}</span>}
            </div>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="Paste a backup JSON here, then Import"
              className="w-full h-20 bg-neutral-800 border border-neutral-700 rounded p-2 text-xs text-neutral-300 font-mono resize-none focus:outline-none focus:border-neutral-500"
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">{title}</h3>
      {hint && <p className="text-xs text-neutral-600 mb-2">{hint}</p>}
      {children}
    </section>
  );
}

function ChipRow({ items, onRemove, empty }: { items: string[]; onRemove: (v: string) => void; empty: string }) {
  if (items.length === 0) return <p className="text-neutral-600 text-xs mb-2">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {items.map((v) => (
        <button
          key={v}
          onClick={() => onRemove(v)}
          className="group text-xs px-2 py-1 rounded bg-neutral-800 border border-neutral-700 text-neutral-300 hover:border-red-700"
          title="Remove"
        >
          {v} <span className="text-neutral-600 group-hover:text-red-400">✕</span>
        </button>
      ))}
    </div>
  );
}

function AddRow({
  value,
  onChange,
  onAdd,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  placeholder: string;
}) {
  return (
    <div className="flex gap-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onAdd();
        }}
        placeholder={placeholder}
        className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-neutral-500"
      />
      <button
        onClick={onAdd}
        className="text-xs px-3 rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500"
      >
        Add
      </button>
    </div>
  );
}

function WeightBar({ label, weight }: { label: string; weight: number }) {
  const pct = Math.min(100, (Math.abs(weight) / 8) * 100);
  const pos = weight > 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-40 truncate text-neutral-300 text-xs">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-neutral-800 overflow-hidden">
        <div className={`h-full rounded-full ${pos ? "bg-green-500" : "bg-red-500"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`tabular-nums text-xs w-10 text-right ${pos ? "text-green-400" : "text-red-400"}`}>
        {pos ? "+" : ""}
        {weight.toFixed(1)}
      </span>
    </div>
  );
}
