'use client';

import { useState, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { X } from 'lucide-react';

interface ChipSelectorProps {
  suggestions: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  allowCustom?: boolean;
  placeholder?: string;
}

export default function ChipSelector({
  suggestions,
  selected,
  onChange,
  allowCustom = true,
  placeholder = 'Add tag...'
}: ChipSelectorProps) {
  const [inputValue, setInputValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const unselected = suggestions.filter((s) => !selected.includes(s));
  const filtered = inputValue
    ? unselected.filter((s) =>
        s.toLowerCase().includes(inputValue.toLowerCase())
      )
    : unselected;

  function addTag(tag: string) {
    const normalized = tag.trim().toLowerCase().replace(/\s+/g, '_');
    if (normalized && !selected.includes(normalized)) {
      onChange([...selected, normalized]);
    }
    setInputValue('');
    setShowSuggestions(false);
  }

  function removeTag(tag: string) {
    onChange(selected.filter((s) => s !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      if (filtered.length > 0) {
        addTag(filtered[0]);
      } else if (allowCustom) {
        addTag(inputValue);
      }
    }
    if (e.key === 'Backspace' && !inputValue && selected.length > 0) {
      removeTag(selected[selected.length - 1]);
    }
  }

  function formatLabel(tag: string): string {
    return tag.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return (
    <div className='space-y-2'>
      {/* Selected chips */}
      {selected.length > 0 && (
        <div className='flex flex-wrap gap-1.5'>
          {selected.map((tag) => (
            <Badge
              key={tag}
              variant='secondary'
              className='cursor-pointer gap-1 pr-1'
              onClick={() => removeTag(tag)}
            >
              {formatLabel(tag)}
              <X className='h-3 w-3' />
            </Badge>
          ))}
        </div>
      )}

      {/* Input with suggestions dropdown */}
      <div className='relative'>
        <Input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className='h-8 text-sm'
        />

        {showSuggestions && filtered.length > 0 && (
          <div className='bg-popover border-border absolute z-10 mt-1 max-h-40 w-full overflow-auto rounded-md border shadow-md'>
            {filtered.map((suggestion) => (
              <button
                key={suggestion}
                type='button'
                className='hover:bg-accent w-full px-3 py-1.5 text-left text-sm'
                onMouseDown={(e) => {
                  e.preventDefault();
                  addTag(suggestion);
                }}
              >
                {formatLabel(suggestion)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
