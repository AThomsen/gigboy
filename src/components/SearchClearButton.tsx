import { X } from 'lucide-react';

interface Props {
  value: string;
  onClear: () => void;
  className?: string;
}

/** "×" inside a search field, rendered next to the input (inside a position: relative wrapper). */
export default function SearchClearButton({ value, onClear, className }: Props) {
  if (!value) return null;
  return (
    <button
      type="button"
      className={`search-clear${className ? ` ${className}` : ''}`}
      aria-label="Clear search"
      onClick={(e) => {
        onClear();
        e.currentTarget.parentElement?.querySelector('input')?.focus();
      }}
    >
      <X size={14} />
    </button>
  );
}
